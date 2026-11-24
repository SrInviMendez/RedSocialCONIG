require("dotenv").config();

const express = require("express");
const httpProxy = require('http-proxy');
const cors = require("cors");
const multer = require("multer");
const sharp = require("sharp");
const cloudinary = require("cloudinary").v2;
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { MongoClient, ObjectId } = require("mongodb");
const {
  randomUUID,
  createHmac,
  timingSafeEqual
} = require("crypto");

const app = express();


cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024,
    files: 1
  },
  fileFilter: (req, file, callback) => {
    const allowed = ["image/jpeg", "image/png", "image/webp"];

    if (!allowed.includes(file.mimetype)) {
      return callback(new Error("Solo se permiten imágenes JPEG, PNG o WebP"));
    }

    callback(null, true);
  }
});

function receiveAvatarFile(req, res, next) {
  avatarUpload.single("avatar")(req, res, error => {
    if (error) {
      return res.status(400).json({
        error: error.code === "LIMIT_FILE_SIZE"
          ? "La fotografía no puede superar los 5 MB"
          : error.message
      });
    }
    next();
  });
}

function receivePostImageFile(req, res, next) {
  avatarUpload.single("image")(req, res, error => {
    if (error) {
      return res.status(400).json({
        error: error.code === "LIMIT_FILE_SIZE"
          ? "La imagen no puede superar los 5 MB"
          : error.message
      });
    }
    next();
  });
}

async function uploadProfileAvatar(file, userId) {
  if (
    !process.env.CLOUDINARY_CLOUD_NAME ||
    !process.env.CLOUDINARY_API_KEY ||
    !process.env.CLOUDINARY_API_SECRET
  ) {
    throw new Error("Falta configurar Cloudinary en .env");
  }

  const metadata = await sharp(file.buffer, {
    failOn: "error"
  }).metadata();

  if (!["jpeg", "png", "webp"].includes(metadata.format)) {
    throw new Error("El contenido del archivo no es una imagen válida");
  }

  const processedImage = await sharp(file.buffer, {
    failOn: "error"
  })
    .rotate()
    .resize(512, 512, {
      fit: "cover",
      position: "centre"
    })
    .webp({ quality: 85 })
    .toBuffer();

  const result = await new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: "red-social/avatars",
        public_id: String(userId),
        overwrite: true,
        resource_type: "image",
        format: "webp"
      },
      (error, uploaded) => {
        if (error) return reject(error);
        resolve(uploaded);
      }
    );

    stream.end(processedImage);
  });

  return {
    avatarUrl: result.secure_url,
    avatarPublicId: result.public_id
  };
}


async function uploadPostImage(file, postId) {
  const metadata = await sharp(file.buffer, {
    failOn: "error"
  }).metadata();

  if (!["jpeg", "png", "webp"].includes(metadata.format)) {
    throw new Error("El archivo no es una imagen válida");
  }

  const processedImage = await sharp(file.buffer, {
    failOn: "error"
  })
    .rotate()
    .resize(512, 512, {
      fit: "cover",
      position: "centre"
    })
    .webp({ quality: 85 })
    .toBuffer();

  const result = await new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: "red-social/posts",
        public_id: String(postId),
        overwrite: false,
        resource_type: "image",
        format: "webp"
      },
      (error, uploaded) => {
        if (error) return reject(error);
        resolve(uploaded);
      }
    );
    stream.end(processedImage);
  });

  return {
    imageUrl: result.secure_url,
    imagePublicId: result.public_id
  };
}



const {
  REGION,
  PORT,
  MONGO_HOST,
  MONGO_PORT,
  MONGO_DB,
  MONGO_USER,
  MONGO_PASSWORD,
  MONGO_REPLICA_SET,
  JWT_SECRET,
  REPLICATION_SECRET,
  PEER_URL
} = process.env;

if (!JWT_SECRET) {
  throw new Error("Falta configurar JWT_SECRET en .env");
}

if (!REPLICATION_SECRET || !PEER_URL) {
  throw new Error("Falta configurar REPLICATION_SECRET o PEER_URL");
}

if (process.env.GATEWAY_ONLY === "true" &&
    !process.env.GATEWAY_SECRET) {
  throw new Error("Falta configurar GATEWAY_SECRET en el nodo protegido");
}

const uri = `mongodb://${MONGO_HOST}:${MONGO_PORT}/?replicaSet=${MONGO_REPLICA_SET}`;

const mongoOptions = {
  auth: {
    username: MONGO_USER,
    password: MONGO_PASSWORD
  },
  authSource: MONGO_DB,
  serverSelectionTimeoutMS: Number(
    process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS || 15000
  )
};

// Render utiliza Tailscale SOCKS5.
// En las máquinas virtuales esta opción queda desactivada.
if (process.env.MONGO_PROXY_HOST) {
  mongoOptions.proxyHost = process.env.MONGO_PROXY_HOST;
  mongoOptions.proxyPort = Number(process.env.MONGO_PROXY_PORT || 1055);
}

const client = new MongoClient(uri, mongoOptions);

app.use(cors());

let activeRequests = 0;
let db;
let replicationRunning = false;

app.use((req, res, next) => {
  activeRequests += 1;
  res.once("finish", () => {
    activeRequests = Math.max(0, activeRequests - 1);
  });
  next();
});

const regionalProxy = httpProxy.createProxyServer({
  changeOrigin: true,
  proxyTimeout: Number(process.env.PEER_TIMEOUT_MS || 75000),
  timeout: Number(process.env.PEER_TIMEOUT_MS || 75000)
});

regionalProxy.on("proxyReq", (proxyReq) => {
  if (process.env.GATEWAY_SECRET) {
    proxyReq.setHeader(
      "x-conig-gateway-key",
      process.env.GATEWAY_SECRET
    );
  }
  proxyReq.setHeader("x-conig-routed", "1");
});

regionalProxy.on("error", (error, req, res) => {
  console.error("Error reenviando solicitud regional:", error.message);

  if (res && !res.headersSent) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      error: "No se pudo comunicar con el servidor interno"
    }));
  }
});

function isTrustedRegionalRequest(req) {
  const secret = process.env.GATEWAY_SECRET || "";
  const received = req.get("x-conig-gateway-key") || "";

  if (!secret || req.get("x-conig-routed") !== "1") {
    return false;
  }

  const expectedBuffer = Buffer.from(secret);
  const receivedBuffer = Buffer.from(received);

  return (
    expectedBuffer.length === receivedBuffer.length &&
    timingSafeEqual(expectedBuffer, receivedBuffer)
  );
}

function forwardToPeer(req, res) {
  if (!PEER_URL) {
    return res.status(503).json({
      error: "El nodo compañero no está configurado"
    });
  }

  regionalProxy.web(req, res, {
    target: PEER_URL,
    changeOrigin: true
  });
}

async function readLoginBody(req) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;

    if (size > 1024 * 1024) {
      throw new Error("La solicitud supera el límite permitido");
    }

    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  const body = JSON.parse(raw || "{}");

  req.body = body;
  return body;
}

// Enrutamiento automático: registro, login y sesiones.
app.use(async (req, res, next) => {
  try {
    const publicPath =
      req.method === "OPTIONS" ||
      req.path === "/" ||
      req.path === "/api/health" ||
      req.path === "/api/admin/bootstrap" ||
      req.path.startsWith("/api/replication/");

    const trusted = isTrustedRegionalRequest(req);

    if (
      process.env.GATEWAY_ONLY === "true" &&
      !publicPath &&
      !trusted
    ) {
      return res.status(403).json({
        error: "Acceso no permitido a este nodo"
      });
    }

    if (publicPath || trusted) {
      return next();
    }

    // Registro: comparar latencia y carga de ambos nodos.
    if (
      req.method === "POST" &&
      req.path === "/api/auth/register"
    ) {
      let localScore = Infinity;
      let peerScore = Infinity;

      try {
        const started = Date.now();
        await db.command({ ping: 1 });

        const latency = Date.now() - started;
        const load = Math.max(0, activeRequests - 1);

        localScore =
          latency +
          load * 250 +
          (load >= 20 ? 5000 : 0);
      } catch (error) {
        console.error("MongoDB local no disponible:", error.message);
      }

      if (PEER_URL) {
        try {
          const started = Date.now();

          const response = await fetch(
            `${PEER_URL}/api/health`,
            {
              signal: AbortSignal.timeout(
                Number(process.env.PEER_TIMEOUT_MS || 75000)
              ),
              cache: "no-store"
            }
          );

          if (response.ok) {
            const health = await response.json();

            if (
              health.status === "active" &&
              health.mongodb === "connected"
            ) {
              const roundTrip = Date.now() - started;
              const load = Number(
                health.load?.activeRequests || 0
              );

              peerScore =
                roundTrip +
                Number(health.latencyMs || 0) +
                load * 250 +
                (health.load?.overloaded ? 5000 : 0);
            }
          }
        } catch (error) {
          console.error("Nodo compañero no disponible:", error.message);
        }
      }

      console.log("Evaluación de asignación:", {
        localScore,
        peerScore
      });

      if (!Number.isFinite(localScore) &&
          !Number.isFinite(peerScore)) {
        return res.status(503).json({
          error: "No hay nodos disponibles para registrar la cuenta"
        });
      }

      if (peerScore < localScore) {
        console.log("Registro asignado al nodo compañero");
        return forwardToPeer(req, res);
      }

      console.log("Registro asignado al nodo local");
      return next();
    }

    // Login: comprobar primero la copia local del usuario.
    if (
      req.method === "POST" &&
      req.path === "/api/auth/login"
    ) {
      let body;

      try {
        body = await readLoginBody(req);
      } catch {
        return res.status(400).json({
          error: "Datos de inicio de sesión inválidos"
        });
      }

      const identifier = String(body.identifier || "")
        .trim()
        .toLowerCase();

      if (!identifier) return next();

      let localUser = null;

      try {
        localUser = await db.collection("users").findOne({
          $or: [
            { username: identifier },
            { email: identifier }
          ]
        }, { projection: { _id: 1 } });
      } catch (error) {
        console.error("Error buscando usuario local:", error.message);
      }

      if (localUser) return next();

      if (!PEER_URL) return next();

      const response = await fetch(
        `${PEER_URL}/api/auth/login`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-conig-gateway-key": process.env.GATEWAY_SECRET || "",
            "x-conig-routed": "1"
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(
            Number(process.env.PEER_TIMEOUT_MS || 75000)
          )
        }
      );

      const responseBody = await response.text();

      res.status(response.status);
      res.type(
        response.headers.get("content-type") || "application/json"
      );

      return res.send(responseBody);
    }

    // Las sesiones se dirigen a la región guardada en el JWT.
    if (req.path.startsWith("/api/")) {
      const authorization = req.headers.authorization || "";

      if (authorization.startsWith("Bearer ")) {
        try {
          const claims = jwt.verify(
            authorization.slice(7),
            JWT_SECRET
          );

          if (
            ["bogota", "cali"].includes(claims.homeRegion) &&
            claims.homeRegion !== REGION
          ) {
            return forwardToPeer(req, res);
          }
        } catch {
          // La ruta original verificará el token y responderá 401.
        }
      }
    }

    next();

  } catch (error) {
    console.error("Error en el enrutamiento regional:", error.message);

    if (!res.headersSent) {
      res.status(503).json({
        error: "No se pudo completar la solicitud"
      });
    }
  }
});

// El parser se ejecuta después del enrutador para permitir el reenvío
// intacto de imágenes multipart y solicitudes JSON.
app.use(express.json());

// Firma de seguridad para los mensajes entre regiones
function signReplicationBody(body) {
  return createHmac("sha256", REPLICATION_SECRET)
    .update(JSON.stringify(body))
    .digest("hex");
}


// Identificador estable para una conversación entre dos usuarios
function buildConversationId(userA, userB) {
  return [String(userA), String(userB)].sort().join("_");
}

// Comprobación del token de usuario
function authenticateToken(req, res, next) {
  const authorization = req.headers.authorization;

  if (!authorization || !authorization.startsWith("Bearer ")) {
    return res.status(401).json({
      error: "Falta el token de acceso"
    });
  }

  try {
    req.auth = jwt.verify(authorization.slice(7), JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({
      error: "Token inválido o vencido"
    });
  }
}

// El rol se consulta en MongoDB en cada solicitud administrativa.
// No se confía en un campo enviado por el navegador ni en el contenido del JWT.
async function requireAdmin(req, res, next) {
  try {
    if (!ObjectId.isValid(req.auth?.sub)) {
      return res.status(401).json({ error: "Identificador de usuario inválido" });
    }

    const user = await db.collection("users").findOne(
      { _id: new ObjectId(req.auth.sub) },
      { projection: { role: 1 } }
    );

    if (!user || user.role !== "admin") {
      return res.status(403).json({ error: "No tienes permisos de administrador" });
    }

    req.adminUserId = new ObjectId(req.auth.sub);
    next();
  } catch (error) {
    console.error("Error verificando permisos administrativos:", error.message);
    res.status(500).json({ error: "No se pudieron verificar los permisos" });
  }
}

// Página de estado del servidor
app.get("/", (req, res) => {
  res.json({
    message: "Servidor de la red social activo",
    region: REGION
  });
});

// Estado, latencia y carga del nodo.
app.get("/api/health", async (req, res) => {
  const startedAt = Date.now();

  try {
    await db.command({ ping: 1 });

    const localInfo = {
      region: REGION,
      status: "active",
      database: MONGO_DB,
      mongodb: "connected",
      latencyMs: Date.now() - startedAt,
      load: {
        activeRequests: Math.max(0, activeRequests - 1),
        overloaded: Math.max(0, activeRequests - 1) >= 20
      },
      timestamp: new Date().toISOString()
    };

    const result = { ...localInfo };

    // Solo la supervisión administrativa solicita el nodo compañero.
    if (req.query.includePeer === "1" && PEER_URL) {
      const peerRegion = REGION === "bogota" ? "cali" : "bogota";

      try {
        const peerResponse = await fetch(
          `${PEER_URL}/api/health`,
          {
            cache: "no-store",
            signal: AbortSignal.timeout(12000)
          }
        );

        const peerInfo = await peerResponse.json();

        result.regions = {
          [REGION]: localInfo,
          [peerRegion]: peerResponse.ok
            ? peerInfo
            : { region: peerRegion, status: "unavailable" }
        };
      } catch {
        result.regions = {
          [REGION]: localInfo,
          [peerRegion]: {
            region: peerRegion,
            status: "unavailable",
            mongodb: "unknown"
          }
        };
      }
    }

    res.json(result);

  } catch {
    res.status(503).json({
      status: "unavailable",
      region: REGION,
      mongodb: "disconnected"
    });
  }
});

// Consultar perfiles públicos del nodo compañero mediante una solicitud firmada.
app.post("/api/replication/users/query", async (req, res) => {
  const body = req.body;

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return res.status(400).json({ error: "Solicitud inválida" });
  }

  const signature = req.get("x-replication-signature") || "";
  if (!/^[a-f0-9]{64}$/i.test(signature)) {
    return res.status(401).json({ error: "Firma inválida" });
  }

  const receivedSignature = Buffer.from(signature, "hex");
  const expectedSignature = Buffer.from(signReplicationBody(body), "hex");
  if (
    receivedSignature.length !== expectedSignature.length ||
    !timingSafeEqual(receivedSignature, expectedSignature)
  ) {
    return res.status(401).json({ error: "No se pudo validar la consulta" });
  }

  const { requestId, requesterRegion, userId } = body;
  if (
    typeof requestId !== "string" || !requestId ||
    !["bogota", "cali"].includes(requesterRegion) ||
    requesterRegion === REGION ||
    (userId !== undefined && !ObjectId.isValid(userId))
  ) {
    return res.status(400).json({ error: "Datos de consulta incompletos o inválidos" });
  }

  try {
    const filter = userId
      ? { _id: new ObjectId(userId) }
      : { homeRegion: REGION };

    const users = await db.collection("users").find(filter, {
      projection: {
        username: 1,
        displayName: 1,
        bio: 1,
        avatarUrl: 1,
        homeRegion: 1,
        createdAt: 1
      }
    }).sort({ createdAt: -1 }).toArray();

    res.json({
      requestId,
      sourceRegion: REGION,
      total: users.length,
      users: users.map(user => ({
        userId: user._id.toString(),
        username: user.username,
        displayName: user.displayName || null,
        bio: user.bio || "",
        avatarUrl: user.avatarUrl || null,
        homeRegion: user.homeRegion,
        createdAt: user.createdAt
      }))
    });
  } catch (error) {
    console.error("Error consultando perfiles para el otro nodo:", error.message);
    res.status(500).json({ error: "No se pudieron consultar los perfiles" });
  }
});

// Recibir registros y actualizaciones de perfil desde la otra región.
app.post("/api/replication/users", async (req, res) => {
  const body = req.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return res.status(400).json({ error: "Mensaje inválido" });
  }

  const signature = req.get("x-replication-signature") || "";
  if (!/^[a-f0-9]{64}$/i.test(signature)) {
    return res.status(401).json({ error: "Firma inválida" });
  }

  const receivedSignature = Buffer.from(signature, "hex");
  const expectedSignature = Buffer.from(signReplicationBody(body), "hex");
  if (
    receivedSignature.length !== expectedSignature.length ||
    !timingSafeEqual(receivedSignature, expectedSignature)
  ) {
    return res.status(401).json({ error: "No se pudo validar el origen del evento" });
  }

  const { eventId, type, sourceRegion, payload } = body;
  const isRegistration = type === "USER_REGISTERED";
  const isProfileUpdate = type === "USER_PROFILE_UPDATED";
  const validAvatarUrl = value => value === null || value === undefined ||
    (typeof value === "string" && value.startsWith("https://res.cloudinary.com/"));

  if (
    !eventId || (!isRegistration && !isProfileUpdate) ||
    !sourceRegion || sourceRegion === REGION || !payload ||
    !ObjectId.isValid(payload.userId) || payload.homeRegion !== sourceRegion ||
    (isRegistration && (!payload.username || !payload.email || !payload.passwordHash)) ||
    (isProfileUpdate && (
      (payload.displayName !== null && typeof payload.displayName !== "string") ||
      typeof payload.bio !== "string" ||
      !payload.updatedAt ||
      (payload.displayName && payload.displayName.length > 40) ||
      payload.bio.length > 160 ||
      !validAvatarUrl(payload.avatarUrl) ||
      (payload.avatarPublicId !== null && payload.avatarPublicId !== undefined &&
        typeof payload.avatarPublicId !== "string")
    )) ||
    (payload.displayName != null &&
      (typeof payload.displayName !== "string" || payload.displayName.length > 40)) ||
    (payload.bio !== undefined &&
      (typeof payload.bio !== "string" || payload.bio.length > 160)) ||
    !validAvatarUrl(payload.avatarUrl) ||
    (payload.avatarPublicId !== undefined && payload.avatarPublicId !== null &&
      typeof payload.avatarPublicId !== "string")
  ) {
    return res.status(400).json({ error: "Datos del evento incompletos o inválidos" });
  }

  const session = client.startSession();
  let duplicate = false;
  try {
    const createdAt = payload.createdAt ? new Date(payload.createdAt) : new Date();
    const updatedAt = isProfileUpdate ? new Date(payload.updatedAt) : null;
    if (Number.isNaN(createdAt.getTime()) ||
        (isProfileUpdate && Number.isNaN(updatedAt.getTime()))) {
      return res.status(400).json({ error: "Fecha del evento inválida" });
    }

    await session.withTransaction(async () => {
      const processed = await db.collection("processed_events").findOne({ eventId }, { session });
      if (processed) {
        duplicate = true;
        return;
      }

      if (isRegistration) {
        await db.collection("users").updateOne(
          { _id: new ObjectId(payload.userId) },
          {
            $setOnInsert: {
              username: payload.username,
              email: payload.email,
              passwordHash: payload.passwordHash,
              homeRegion: payload.homeRegion,
              role: "user",
              displayName: payload.displayName || null,
              bio: payload.bio || "",
              avatarUrl: payload.avatarUrl || null,
              avatarPublicId: payload.avatarPublicId || null,
              createdAt
            }
          },
          { upsert: true, session }
        );
      } else {
        const updated = await db.collection("users").updateOne(
          { _id: new ObjectId(payload.userId), homeRegion: sourceRegion },
          {
            $set: {
              displayName: payload.displayName || null,
              bio: payload.bio || "",
              avatarUrl: payload.avatarUrl || null,
              avatarPublicId: payload.avatarPublicId || null,
              profileUpdatedAt: updatedAt
            }
          },
          { session }
        );
        if (!updated.matchedCount) {
          const error = new Error("El usuario todavía no está replicado en este nodo");
          error.statusCode = 503;
          throw error;
        }
      }

      await db.collection("processed_events").insertOne({
        eventId,
        sourceRegion,
        processedAt: new Date()
      }, { session });
    });

    res.json({
      message: duplicate ? "Evento de usuario ya procesado" :
        (isRegistration ? "Usuario replicado correctamente" : "Perfil actualizado en el nodo compañero"),
      duplicate
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ error: "Conflicto con el usuario o correo replicado" });
    }
    console.error("Error recibiendo evento de usuario:", error.message);
    res.status(error.statusCode || 500).json({
      error: error.statusCode === 503 ? error.message : "No se pudo procesar el evento de usuario"
    });
  } finally {
    await session.endSession();
  }
});


// Recibir una publicación replicada desde otra región
app.post("/api/replication/posts", async (req, res) => {
  const body = req.body;

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return res.status(400).json({ error: "Mensaje inválido" });
  }

  const signature = req.get("x-replication-signature") || "";

  if (!/^[a-f0-9]{64}$/i.test(signature)) {
    return res.status(401).json({ error: "Firma inválida" });
  }

  const receivedSignature = Buffer.from(signature, "hex");
  const expectedSignature = Buffer.from(signReplicationBody(body), "hex");

  if (
    receivedSignature.length !== expectedSignature.length ||
    !timingSafeEqual(receivedSignature, expectedSignature)
  ) {
    return res.status(401).json({
      error: "No se pudo validar el origen del evento"
    });
  }

  const { eventId, type, sourceRegion, payload } = body;

  if (type === "POST_DELETED") {
    if (
      typeof eventId !== "string" || !eventId ||
      typeof sourceRegion !== "string" || !sourceRegion || sourceRegion === REGION ||
      !payload || typeof payload.postId !== "string" || !payload.postId ||
      !ObjectId.isValid(payload.authorId)
    ) {
      return res.status(400).json({ error: "Datos de eliminación de publicación inválidos" });
    }

    const deletedAt = new Date(payload.deletedAt);
    if (Number.isNaN(deletedAt.getTime())) {
      return res.status(400).json({ error: "Fecha de eliminación inválida" });
    }

    const session = client.startSession();
    let duplicate = false;
    try {
      await session.withTransaction(async () => {
        const processed = await db.collection("processed_events").findOne({ eventId }, { session });
        if (processed) {
          duplicate = true;
          return;
        }

        await db.collection("posts").deleteOne(
          { postId: payload.postId, authorId: new ObjectId(payload.authorId) },
          { session }
        );
        await db.collection("likes").deleteMany({ postId: payload.postId }, { session });
        await db.collection("processed_events").insertOne({
          eventId,
          sourceRegion,
          processedAt: new Date()
        }, { session });
      });

      return res.json({
        message: duplicate ? "Eliminación ya procesada" : "Publicación eliminada en la otra región",
        duplicate
      });
    } catch (error) {
      console.error("Error replicando eliminación de publicación:", error.message);
      return res.status(500).json({ error: "No se pudo replicar la eliminación" });
    } finally {
      await session.endSession();
    }
  }

  if (
    !eventId ||
    type !== "POST_CREATED" ||
    typeof sourceRegion !== "string" ||
    !sourceRegion ||
    sourceRegion === REGION ||
    !payload ||
    typeof payload.postId !== "string" ||
    !ObjectId.isValid(payload.authorId) ||
    typeof payload.authorRegion !== "string" ||
    typeof payload.content !== "string" ||
    payload.content.trim().length < 1 ||
    payload.content.trim().length > 280 ||
    (payload.imageUrl != null &&
      (typeof payload.imageUrl !== "string" ||
       !payload.imageUrl.startsWith("https://res.cloudinary.com/"))) ||
    (payload.imagePublicId != null &&
      typeof payload.imagePublicId !== "string")
  ) {
    return res.status(400).json({
      error: "Datos de la publicación incompletos o inválidos"
    });
  }

  const createdAt = new Date(payload.createdAt);

  if (Number.isNaN(createdAt.getTime())) {
    return res.status(400).json({
      error: "Fecha de publicación inválida"
    });
  }

  const session = client.startSession();
  let duplicate = false;

  try {
    await session.withTransaction(async () => {
      const processed = await db.collection("processed_events").findOne(
        { eventId },
        { session }
      );

      if (processed) {
        duplicate = true;
        return;
      }

      const author = await db.collection("users").findOne(
        { _id: new ObjectId(payload.authorId) },
        { session, projection: { _id: 1 } }
      );

      if (!author) {
        const error = new Error("El autor todavía no está replicado");
        error.statusCode = 503;
        throw error;
      }

      await db.collection("posts").updateOne(
        { postId: payload.postId },
        {
          $setOnInsert: {
            postId: payload.postId,
            authorId: new ObjectId(payload.authorId),
            authorRegion: payload.authorRegion,
            sourceRegion,
            content: payload.content.trim(),
            imageUrl: payload.imageUrl || null,
            imagePublicId: payload.imagePublicId || null,
            createdAt
          }
        },
        { upsert: true, session }
      );

      await db.collection("processed_events").insertOne({
        eventId,
        sourceRegion,
        processedAt: new Date()
      }, { session });
    });

    res.json({
      message: duplicate
        ? "Publicación ya procesada"
        : "Publicación replicada correctamente",
      duplicate
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({
        error: "Conflicto con el identificador de la publicación"
      });
    }

    console.error("Error recibiendo publicación:", error.message);

    res.status(error.statusCode || 500).json({
      error: error.statusCode === 503
        ? error.message
        : "No se pudo procesar la publicación"
    });
  } finally {
    await session.endSession();
  }
});




// Consulta interna del fragmento local de publicaciones

app.post("/api/replication/posts/query", async (req, res) => {
  const body = req.body;

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return res.status(400).json({ error: "Solicitud inválida" });
  }

  const signature = req.get("x-replication-signature") || "";
  if (!/^[a-f0-9]{64}$/i.test(signature)) {
    return res.status(401).json({ error: "Firma inválida" });
  }

  const receivedSignature = Buffer.from(signature, "hex");
  const expectedSignature = Buffer.from(signReplicationBody(body), "hex");
  if (
    receivedSignature.length !== expectedSignature.length ||
    !timingSafeEqual(receivedSignature, expectedSignature)
  ) {
    return res.status(401).json({ error: "No se pudo validar el origen de la consulta" });
  }

  const { requestId, requesterRegion, authorId } = body;
  if (
    typeof requestId !== "string" || !requestId ||
    typeof requesterRegion !== "string" || !requesterRegion ||
    requesterRegion === REGION ||
    (authorId !== undefined && !ObjectId.isValid(authorId))
  ) {
    return res.status(400).json({ error: "Datos de consulta incompletos o inválidos" });
  }

  try {
    const filter = { sourceRegion: REGION };
    if (authorId) filter.authorId = new ObjectId(authorId);

    const posts = await db.collection("posts")
      .find(filter)
      .sort({ createdAt: -1 })
      .limit(50)
      .toArray();

    const authorIds = [...new Map(
      posts.map(post => [post.authorId.toString(), post.authorId])
    ).values()];

    const authors = authorIds.length
      ? await db.collection("users").find(
          { _id: { $in: authorIds } },
          { projection: { username: 1, displayName: 1, avatarUrl: 1 } }
        ).toArray()
      : [];

    const authorsById = new Map(authors.map(user => [user._id.toString(), user]));

    res.json({
      requestId,
      sourceRegion: REGION,
      total: posts.length,
      posts: posts.map(post => {
        const author = authorsById.get(post.authorId.toString());
        return {
          postId: post.postId,
          authorId: post.authorId.toString(),
          authorRegion: post.authorRegion,
          sourceRegion: post.sourceRegion,
          author: author ? {
            userId: author._id.toString(),
            username: author.username,
            displayName: author.displayName || null,
            avatarUrl: author.avatarUrl || null
          } : null,
          content: post.content,
          imageUrl: post.imageUrl || null,
          createdAt: post.createdAt
        };
      })
    });
  } catch (error) {
    console.error("Error consultando fragmento local:", error.message);
    res.status(500).json({ error: "No se pudo consultar el fragmento local" });
  }
});

// Recibir relaciones de seguimiento desde otra región
app.post("/api/replication/follows", async (req, res) => {
  const body = req.body;

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return res.status(400).json({ error: "Mensaje inválido" });
  }

  const signature = req.get("x-replication-signature") || "";

  if (!/^[a-f0-9]{64}$/i.test(signature)) {
    return res.status(401).json({ error: "Firma inválida" });
  }

  const receivedSignature = Buffer.from(signature, "hex");
  const expectedSignature = Buffer.from(signReplicationBody(body), "hex");

  if (
    receivedSignature.length !== expectedSignature.length ||
    !timingSafeEqual(receivedSignature, expectedSignature)
  ) {
    return res.status(401).json({
      error: "No se pudo validar el origen del evento"
    });
  }

  const { eventId, type, sourceRegion, payload } = body;

  if (
    !eventId ||
    !["FOLLOW_CREATED", "FOLLOW_DELETED"].includes(type) ||
    typeof sourceRegion !== "string" ||
    !sourceRegion ||
    sourceRegion === REGION ||
    !payload ||
    !ObjectId.isValid(payload.followerId) ||
    !ObjectId.isValid(payload.followedId) ||
    payload.followerId === payload.followedId
  ) {
    return res.status(400).json({
      error: "Datos de seguimiento incompletos o inválidos"
    });
  }

  const createdAt = new Date(payload.createdAt);

  if (Number.isNaN(createdAt.getTime())) {
    return res.status(400).json({
      error: "Fecha de seguimiento inválida"
    });
  }

  const followerId = new ObjectId(payload.followerId);
  const followedId = new ObjectId(payload.followedId);
  const session = client.startSession();
  let duplicate = false;

  try {
    await session.withTransaction(async () => {
      const processed = await db.collection("processed_events").findOne(
        { eventId },
        { session }
      );

      if (processed) {
        duplicate = true;
        return;
      }

      const users = await db.collection("users").find(
        { _id: { $in: [followerId, followedId] } },
        { session, projection: { _id: 1 } }
      ).toArray();

      if (users.length !== 2) {
        const error = new Error("Uno de los usuarios todavía no está replicado");
        error.statusCode = 503;
        throw error;
      }

      if (type === "FOLLOW_CREATED") {
        await db.collection("follows").updateOne(
          { followerId, followedId },
          {
            $setOnInsert: {
              followerId,
              followedId,
              sourceRegion,
              createdAt
            }
          },
          { upsert: true, session }
        );
      } else {
        await db.collection("follows").deleteOne(
          { followerId, followedId },
          { session }
        );
      }

      await db.collection("processed_events").insertOne({
        eventId,
        sourceRegion,
        processedAt: new Date()
      }, { session });
    });

    res.json({
      message: duplicate
        ? "Evento de seguimiento ya procesado"
        : "Relación de seguimiento sincronizada",
      duplicate
    });
  } catch (error) {
    console.error("Error recibiendo seguimiento:", error.message);

    res.status(error.statusCode || 500).json({
      error: error.statusCode === 503
        ? error.message
        : "No se pudo sincronizar el seguimiento"
    });
  } finally {
    await session.endSession();
  }
});



// Recibir mensajes y confirmaciones de mensajería desde otra región

// Recibir likes desde la otra región
app.post("/api/replication/likes", async (req, res) => {
  const body = req.body;

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return res.status(400).json({ error: "Mensaje inválido" });
  }

  const signature = req.get("x-replication-signature") || "";

  if (!/^[a-f0-9]{64}$/i.test(signature)) {
    return res.status(401).json({ error: "Firma inválida" });
  }

  const receivedSignature = Buffer.from(signature, "hex");
  const expectedSignature = Buffer.from(signReplicationBody(body), "hex");

  if (
    receivedSignature.length !== expectedSignature.length ||
    !timingSafeEqual(receivedSignature, expectedSignature)
  ) {
    return res.status(401).json({
      error: "No se pudo validar el origen del evento"
    });
  }

  const { eventId, type, sourceRegion, payload } = body;

  if (
    typeof eventId !== "string" ||
    !eventId ||
    !["LIKE_CREATED", "LIKE_DELETED"].includes(type) ||
    typeof sourceRegion !== "string" ||
    !sourceRegion ||
    sourceRegion === REGION ||
    !payload ||
    typeof payload.postId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(payload.postId) ||
    !ObjectId.isValid(payload.userId)
  ) {
    return res.status(400).json({
      error: "Datos del like incompletos o inválidos"
    });
  }

  const createdAt = new Date(payload.createdAt);

  if (Number.isNaN(createdAt.getTime())) {
    return res.status(400).json({
      error: "Fecha del like inválida"
    });
  }

  const userId = new ObjectId(payload.userId);
  const session = client.startSession();
  let duplicate = false;

  try {
    await session.withTransaction(async () => {
      const processed = await db.collection("processed_events").findOne(
        { eventId },
        { session }
      );

      if (processed) {
        duplicate = true;
        return;
      }

      if (type === "LIKE_CREATED") {
        await db.collection("likes").updateOne(
          { postId: payload.postId, userId },
          {
            $setOnInsert: {
              postId: payload.postId,
              userId,
              sourceRegion,
              createdAt
            }
          },
          { upsert: true, session }
        );
      } else {
        await db.collection("likes").deleteOne(
          { postId: payload.postId, userId },
          { session }
        );
      }

      await db.collection("processed_events").insertOne({
        eventId,
        sourceRegion,
        processedAt: new Date()
      }, { session });
    });

    res.json({
      message: duplicate ? "Evento de like ya procesado" : "Like sincronizado",
      duplicate
    });
  } catch (error) {
    console.error("Error recibiendo like:", error.message);
    res.status(500).json({
      error: "No se pudo sincronizar el like"
    });
  } finally {
    await session.endSession();
  }
});

app.post("/api/replication/messages", async (req, res) => {
  const body = req.body;

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return res.status(400).json({ error: "Mensaje inválido" });
  }

  const signature = req.get("x-replication-signature") || "";

  if (!/^[a-f0-9]{64}$/i.test(signature)) {
    return res.status(401).json({ error: "Firma inválida" });
  }

  const receivedSignature = Buffer.from(signature, "hex");
  const expectedSignature = Buffer.from(signReplicationBody(body), "hex");

  if (
    receivedSignature.length !== expectedSignature.length ||
    !timingSafeEqual(receivedSignature, expectedSignature)
  ) {
    return res.status(401).json({
      error: "No se pudo validar el origen del evento"
    });
  }

  const { eventId, type, sourceRegion, payload } = body;

  if (
    typeof eventId !== "string" ||
    !eventId ||
    !["MESSAGE_SENT", "MESSAGE_DELIVERED", "MESSAGE_READ"].includes(type) ||
    typeof sourceRegion !== "string" ||
    !sourceRegion ||
    sourceRegion === REGION ||
    !payload ||
    typeof payload.messageId !== "string" ||
    !payload.messageId ||
    typeof payload.conversationId !== "string" ||
    !ObjectId.isValid(payload.senderId) ||
    !ObjectId.isValid(payload.recipientId) ||
    payload.senderId === payload.recipientId
  ) {
    return res.status(400).json({
      error: "Datos del evento de mensajería incompletos o inválidos"
    });
  }

  const senderId = new ObjectId(payload.senderId);
  const recipientId = new ObjectId(payload.recipientId);
  const conversationId = buildConversationId(senderId, recipientId);

  if (payload.conversationId !== conversationId) {
    return res.status(400).json({
      error: "Identificador de conversación inválido"
    });
  }

  let createdAt;
  let deliveredAt;
  let readAt;

  if (type === "MESSAGE_SENT") {
    createdAt = new Date(payload.createdAt);

    if (
      Number.isNaN(createdAt.getTime()) ||
      typeof payload.content !== "string" ||
      payload.content.trim().length < 1 ||
      payload.content.trim().length > 2000 ||
      payload.senderRegion !== sourceRegion
    ) {
      return res.status(400).json({
        error: "Datos del mensaje inválidos"
      });
    }
  } else {
    deliveredAt = new Date(payload.deliveredAt);

    if (Number.isNaN(deliveredAt.getTime())) {
      return res.status(400).json({
        error: "Fecha de entrega inválida"
      });
    }

    if (type === "MESSAGE_READ") {
      readAt = new Date(payload.readAt);

      if (Number.isNaN(readAt.getTime())) {
        return res.status(400).json({
          error: "Fecha de lectura inválida"
        });
      }
    }
  }

  const session = client.startSession();
  let duplicate = false;

  try {
    await session.withTransaction(async () => {
      const processed = await db.collection("processed_events").findOne(
        { eventId },
        { session }
      );

      if (processed) {
        duplicate = true;
        return;
      }

      if (type === "MESSAGE_SENT") {
        const users = await db.collection("users").find(
          { _id: { $in: [senderId, recipientId] } },
          { session, projection: { _id: 1 } }
        ).toArray();

        if (users.length !== 2) {
          const error = new Error(
            "Uno de los participantes todavía no está replicado"
          );
          error.statusCode = 503;
          throw error;
        }

        const deliveredAtLocal = new Date();

        await db.collection("conversations").updateOne(
          { _id: conversationId },
          {
            $setOnInsert: {
              _id: conversationId,
              participantIds: [senderId, recipientId],
              createdAt,
              status: payload.conversationStatus === "pending" ? "pending" : "accepted",
              requestedBy: ObjectId.isValid(payload.requestedBy)
                ? new ObjectId(payload.requestedBy)
                : null
            },
            $max: {
              lastMessageAt: createdAt
            }
          },
          { upsert: true, session }
        );

        const incomingRequesterId = ObjectId.isValid(payload.requestedBy)
          ? new ObjectId(payload.requestedBy)
          : null;
        if (payload.conversationStatus === "pending" && incomingRequesterId) {
          const storedConversation = await db.collection("conversations").findOne(
            { _id: conversationId }, { session }
          );
          if (storedConversation && storedConversation.requestedBy &&
              !storedConversation.requestedBy.equals(incomingRequesterId)) {
            await db.collection("conversations").updateOne(
              { _id: conversationId },
              { $set: { status: "pending", requestedBy: incomingRequesterId } },
              { session }
            );
          }
        }

        await db.collection("messages").updateOne(
          { messageId: payload.messageId },
          {
            $setOnInsert: {
              messageId: payload.messageId,
              conversationId,
              senderId,
              recipientId,
              senderRegion: sourceRegion,
              content: payload.content.trim(),
              createdAt,
              deliveryStatus: "delivered",
              deliveredAt: deliveredAtLocal,
              readAt: null
            }
          },
          { upsert: true, session }
        );

        await db.collection("outbox").insertOne({
          eventId: randomUUID(),
          type: "MESSAGE_DELIVERED",
          sourceRegion: REGION,
          createdAt: deliveredAtLocal,
          payload: {
            messageId: payload.messageId,
            conversationId,
            senderId: senderId.toString(),
            recipientId: recipientId.toString(),
            deliveredAt: deliveredAtLocal
          }
        }, { session });

      } else {
        const existingMessage = await db.collection("messages").findOne(
          {
            messageId: payload.messageId,
            conversationId,
            senderId,
            recipientId
          },
          { session }
        );

        if (!existingMessage) {
          const error = new Error(
            "El mensaje original todavía no está disponible"
          );
          error.statusCode = 503;
          throw error;
        }

        if (type === "MESSAGE_DELIVERED") {
          if (existingMessage.deliveryStatus !== "read") {
            await db.collection("messages").updateOne(
              { messageId: payload.messageId },
              {
                $set: {
                  deliveryStatus: "delivered",
                  deliveredAt
                }
              },
              { session }
            );
          }
        } else {
          await db.collection("messages").updateOne(
            { messageId: payload.messageId },
            {
              $set: {
                deliveryStatus: "read",
                deliveredAt,
                readAt
              }
            },
            { session }
          );
        }
      }

      await db.collection("processed_events").insertOne({
        eventId,
        sourceRegion,
        processedAt: new Date()
      }, { session });
    });

    res.json({
      message: duplicate
        ? "Evento de mensajería ya procesado"
        : "Evento de mensajería sincronizado",
      duplicate
    });

  } catch (error) {
    console.error("Error recibiendo evento de mensajería:", error.message);

    res.status(error.statusCode || 500).json({
      error: error.statusCode === 503
        ? error.message
        : "No se pudo sincronizar el evento de mensajería"
    });

  } finally {
    await session.endSession();
  }
});


// Replicar aceptación de solicitudes y borrado individual de conversaciones.
app.post("/api/replication/conversations", async (req, res) => {
  const body = req.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return res.status(400).json({ error: "Solicitud inválida" });
  }

  const signature = req.get("x-replication-signature") || "";
  if (!/^[a-f0-9]{64}$/i.test(signature)) {
    return res.status(401).json({ error: "Firma inválida" });
  }
  const receivedSignature = Buffer.from(signature, "hex");
  const expectedSignature = Buffer.from(signReplicationBody(body), "hex");
  if (receivedSignature.length !== expectedSignature.length ||
      !timingSafeEqual(receivedSignature, expectedSignature)) {
    return res.status(401).json({ error: "No se pudo validar el origen del evento" });
  }

  const { eventId, type, sourceRegion, payload } = body;
  const actorField = type === "CONVERSATION_ACCEPTED" ? "acceptedBy" : "userId";
  if (typeof eventId !== "string" || !eventId ||
      !["CONVERSATION_ACCEPTED", "CONVERSATION_CLEARED"].includes(type) ||
      typeof sourceRegion !== "string" || !sourceRegion || sourceRegion === REGION ||
      !payload || typeof payload.conversationId !== "string" ||
      !ObjectId.isValid(payload[actorField])) {
    return res.status(400).json({ error: "Datos de conversación incompletos o inválidos" });
  }

  const actorId = new ObjectId(payload[actorField]);
  const eventDate = new Date(type === "CONVERSATION_ACCEPTED" ? payload.acceptedAt : payload.clearedAt);
  if (Number.isNaN(eventDate.getTime())) {
    return res.status(400).json({ error: "Fecha de conversación inválida" });
  }

  const session = client.startSession();
  let duplicate = false;
  try {
    await session.withTransaction(async () => {
      const processed = await db.collection("processed_events").findOne({ eventId }, { session });
      if (processed) {
        duplicate = true;
        return;
      }

      const conversation = await db.collection("conversations").findOne(
        { _id: payload.conversationId, participantIds: actorId },
        { session }
      );
      if (!conversation) {
        const error = new Error("La conversación todavía no está disponible en esta región");
        error.statusCode = 503;
        throw error;
      }

      if (type === "CONVERSATION_ACCEPTED") {
        await db.collection("conversations").updateOne(
          { _id: payload.conversationId, participantIds: actorId },
          { $set: { status: "accepted", acceptedBy: actorId, acceptedAt: eventDate } },
          { session }
        );
      } else {
        const currentMarker = (conversation.clearedBy || []).find(item =>
          item.userId && item.userId.equals(actorId)
        );
        if (currentMarker) {
          await db.collection("conversations").updateOne(
            { _id: payload.conversationId, "clearedBy.userId": actorId },
            { $set: { "clearedBy.$.clearedAt": eventDate } },
            { session }
          );
        } else {
          await db.collection("conversations").updateOne(
            { _id: payload.conversationId },
            { $push: { clearedBy: { userId: actorId, clearedAt: eventDate } } },
            { session }
          );
        }
      }

      await db.collection("processed_events").insertOne({
        eventId,
        sourceRegion,
        processedAt: new Date()
      }, { session });
    });

    res.json({
      message: duplicate ? "Evento de conversación ya procesado" : "Conversación sincronizada",
      duplicate
    });
  } catch (error) {
    console.error("Error recibiendo evento de conversación:", error.message);
    res.status(error.statusCode || 500).json({
      error: error.statusCode === 503 ? error.message : "No se pudo sincronizar la conversación"
    });
  } finally {
    await session.endSession();
  }
});


// Replicar asignaciones y retiros de roles administrativos.
app.post("/api/replication/admins", async (req, res) => {
  const body = req.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return res.status(400).json({ error: "Solicitud inválida" });
  }

  const signature = req.get("x-replication-signature") || "";
  if (!/^[a-f0-9]{64}$/i.test(signature)) {
    return res.status(401).json({ error: "Firma inválida" });
  }

  const receivedSignature = Buffer.from(signature, "hex");
  const expectedSignature = Buffer.from(signReplicationBody(body), "hex");
  if (
    receivedSignature.length !== expectedSignature.length ||
    !timingSafeEqual(receivedSignature, expectedSignature)
  ) {
    return res.status(401).json({ error: "No se pudo validar el origen del evento" });
  }

  const { eventId, type, sourceRegion, payload } = body;
  if (
    typeof eventId !== "string" || !eventId ||
    type !== "ADMIN_ROLE_UPDATED" ||
    typeof sourceRegion !== "string" || !sourceRegion || sourceRegion === REGION ||
    !payload || !ObjectId.isValid(payload.userId) ||
    !["admin", "user"].includes(payload.role)
  ) {
    return res.status(400).json({ error: "Datos del cambio de rol inválidos" });
  }

  const session = client.startSession();
  let duplicate = false;
  try {
    await session.withTransaction(async () => {
      const processed = await db.collection("processed_events").findOne({ eventId }, { session });
      if (processed) {
        duplicate = true;
        return;
      }

      const result = await db.collection("users").updateOne(
        { _id: new ObjectId(payload.userId) },
        { $set: { role: payload.role, roleUpdatedAt: new Date(payload.updatedAt) } },
        { session }
      );

      if (!result.matchedCount) {
        const error = new Error("El usuario todavía no está replicado en este nodo");
        error.statusCode = 503;
        throw error;
      }

      await db.collection("processed_events").insertOne({
        eventId,
        sourceRegion,
        processedAt: new Date()
      }, { session });
    });

    res.json({
      message: duplicate ? "Cambio de rol ya procesado" : "Rol administrativo sincronizado",
      duplicate
    });
  } catch (error) {
    console.error("Error replicando rol administrativo:", error.message);
    res.status(error.statusCode || 500).json({
      error: error.statusCode === 503 ? error.message : "No se pudo sincronizar el rol"
    });
  } finally {
    await session.endSession();
  }
});


// Registro de usuarios con fotografía obligatoria
app.post("/api/auth/register", receiveAvatarFile, async (req, res) => {
  const { username, email, password } = req.body || {};

  if (!username || !email || !password) {
    return res.status(400).json({
      error: "Debes proporcionar usuario, correo y contraseña"
    });
  }

  if (!req.file) {
    return res.status(400).json({
      error: "Debes seleccionar una fotografía de perfil"
    });
  }

  const normalizedUsername = String(username).trim().toLowerCase();
  const normalizedEmail = String(email).trim().toLowerCase();

  if (!/^[a-z0-9_]{3,20}$/.test(normalizedUsername)) {
    return res.status(400).json({
      error: "El usuario debe tener entre 3 y 20 caracteres"
    });
  }

  if (
    normalizedEmail.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)
  ) {
    return res.status(400).json({
      error: "El correo electrónico no es válido"
    });
  }

  if (typeof password !== "string" || password.length < 8) {
    return res.status(400).json({
      error: "La contraseña debe tener al menos 8 caracteres"
    });
  }

  const displayNameInput = req.body.displayName;
  const bioInput = req.body.bio;

  if (
    displayNameInput !== undefined &&
    displayNameInput !== null &&
    typeof displayNameInput !== "string"
  ) {
    return res.status(400).json({
      error: "El nombre visible no es válido"
    });
  }

  if (
    bioInput !== undefined &&
    bioInput !== null &&
    typeof bioInput !== "string"
  ) {
    return res.status(400).json({
      error: "La biografía no es válida"
    });
  }

  const displayName = displayNameInput
    ? displayNameInput.trim()
    : "";

  const bio = bioInput
    ? bioInput.trim()
    : "";

  if (displayName.length > 40) {
    return res.status(400).json({
      error: "El nombre visible no puede superar 40 caracteres"
    });
  }

  if (bio.length > 160) {
    return res.status(400).json({
      error: "La biografía no puede superar 160 caracteres"
    });
  }

  const session = client.startSession();
  const userId = new ObjectId();
  const eventId = randomUUID();
  const createdAt = new Date();

  let uploadedAvatar = null;

  try {
    const passwordHash = await bcrypt.hash(password, 12);

    uploadedAvatar = await uploadProfileAvatar(req.file, userId);

    await session.withTransaction(async () => {
      await db.collection("users").insertOne({
        _id: userId,
        username: normalizedUsername,
        email: normalizedEmail,
        passwordHash,
        displayName: displayName || null,
        bio,
        avatarUrl: uploadedAvatar.avatarUrl,
        avatarPublicId: uploadedAvatar.avatarPublicId,
        homeRegion: REGION,
        role: "user",
        createdAt
      }, { session });

      await db.collection("outbox").insertOne({
        eventId,
        type: "USER_REGISTERED",
        sourceRegion: REGION,
        createdAt,
        payload: {
          userId: userId.toString(),
          username: normalizedUsername,
          email: normalizedEmail,
          passwordHash,
          displayName: displayName || null,
          bio,
          avatarUrl: uploadedAvatar.avatarUrl,
          avatarPublicId: uploadedAvatar.avatarPublicId,
          homeRegion: REGION,
          createdAt
        }
      }, { session });
    });

    res.status(201).json({
      message: "Usuario registrado correctamente",
      user: {
        id: userId.toString(),
        username: normalizedUsername,
        displayName: displayName || null,
        bio,
        avatarUrl: uploadedAvatar.avatarUrl,
        email: normalizedEmail,
        homeRegion: REGION
      }
    });

  } catch (error) {
    if (uploadedAvatar?.avatarPublicId) {
      await cloudinary.uploader.destroy(
        uploadedAvatar.avatarPublicId,
        { resource_type: "image" }
      ).catch(cleanupError => {
        console.error("No se pudo eliminar la fotografía temporal:", cleanupError.message);
      });
    }

    if (error.code === 11000) {
      return res.status(409).json({
        error: "Ese nombre de usuario o correo ya existe en este nodo"
      });
    }

    console.error("Error en el registro:", error.message);

    res.status(500).json({
      error: "No se pudo completar el registro o almacenar la fotografía"
    });

  } finally {
    await session.endSession();
  }
});

// Inicio de sesión
app.post("/api/auth/login", async (req, res) => {
  const { identifier, password } = req.body;

  if (!identifier || !password) {
    return res.status(400).json({
      error: "Debes proporcionar usuario o correo y contraseña"
    });
  }

  try {
    const value = String(identifier).trim().toLowerCase();

    const user = await db.collection("users").findOne({
      $or: [
        { username: value },
        { email: value }
      ]
    });

    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      return res.status(401).json({
        error: "Usuario o contraseña incorrectos"
      });
    }

    const token = jwt.sign(
      { homeRegion: user.homeRegion },
      JWT_SECRET,
      {
        subject: user._id.toString(),
        expiresIn: "12h"
      }
    );

    res.json({
      message: "Inicio de sesión correcto",
      token,
      user: {
        id: user._id.toString(),
        username: user.username,
        email: user.email,
        displayName: user.displayName || null,
        bio: user.bio || "",
        avatarUrl: user.avatarUrl || null,
        homeRegion: user.homeRegion
      }
    });
  } catch (error) {
    console.error("Error en el inicio de sesión:", error.message);
    res.status(500).json({
      error: "No se pudo iniciar sesión"
    });
  }
});

// Consultar el perfil del usuario autenticado
app.get("/api/me", authenticateToken, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.auth.sub)) {
      return res.status(401).json({
        error: "Identificador de usuario inválido"
      });
    }

    const user = await db.collection("users").findOne(
      { _id: new ObjectId(req.auth.sub) },
      { projection: { passwordHash: 0 } }
    );

    if (!user) {
      return res.status(404).json({
        error: "Usuario no encontrado en este nodo"
      });
    }

    res.json({
      id: user._id.toString(),
      username: user.username,
      email: user.email,
      displayName: user.displayName || null,
      bio: user.bio || "",
      avatarUrl: user.avatarUrl || null,
      homeRegion: user.homeRegion,
      role: user.role || "user",
      isAdmin: user.role === "admin",
      createdAt: user.createdAt
    });
  } catch (error) {
    console.error("Error consultando perfil:", error.message);
    res.status(500).json({
      error: "No se pudo consultar el perfil"
    });
  }
});



// Actualizar únicamente el nombre visible, la biografía y la fotografía del perfil propio.
app.patch("/api/me", authenticateToken, receiveAvatarFile, async (req, res) => {
  if (!ObjectId.isValid(req.auth.sub)) {
    return res.status(401).json({ error: "Identificador de usuario inválido" });
  }

  const userId = new ObjectId(req.auth.sub);
  const session = client.startSession();
  let uploadedAvatar = null;

  try {
    const currentUser = await db.collection("users").findOne({ _id: userId });
    if (!currentUser) {
      return res.status(404).json({ error: "No se encontró el perfil del usuario" });
    }

    const displayNameInput = req.body?.displayName;
    const bioInput = req.body?.bio;

    if (typeof displayNameInput !== "string" || typeof bioInput !== "string") {
      return res.status(400).json({ error: "Debes proporcionar el nombre visible y la biografía" });
    }

    const displayName = displayNameInput.trim();
    const bio = bioInput.trim();

    if (displayName.length > 40) {
      return res.status(400).json({ error: "El nombre visible no puede superar 40 caracteres" });
    }
    if (bio.length > 160) {
      return res.status(400).json({ error: "La biografía no puede superar 160 caracteres" });
    }

    if (req.file) {
      uploadedAvatar = await uploadProfileAvatar(req.file, userId);
    }

    const avatarUrl = uploadedAvatar?.avatarUrl || currentUser.avatarUrl || null;
    const avatarPublicId = uploadedAvatar?.avatarPublicId || currentUser.avatarPublicId || null;
    const updatedAt = new Date();
    const profileData = {
      displayName: displayName || null,
      bio,
      avatarUrl,
      avatarPublicId
    };

    await session.withTransaction(async () => {
      const result = await db.collection("users").updateOne(
        { _id: userId },
        { $set: { ...profileData, profileUpdatedAt: updatedAt } },
        { session }
      );

      if (!result.matchedCount) {
        throw new Error("El perfil dejó de estar disponible durante la actualización");
      }

      await db.collection("outbox").insertOne({
        eventId: randomUUID(),
        type: "USER_PROFILE_UPDATED",
        sourceRegion: REGION,
        createdAt: updatedAt,
        payload: {
          userId: userId.toString(),
          homeRegion: currentUser.homeRegion,
          ...profileData,
          updatedAt
        }
      }, { session });
    });

    res.json({
      message: "Perfil actualizado correctamente",
      user: {
        id: userId.toString(),
        username: currentUser.username,
        displayName: profileData.displayName,
        bio: profileData.bio,
        avatarUrl: profileData.avatarUrl,
        homeRegion: currentUser.homeRegion
      }
    });
  } catch (error) {
    console.error("Error actualizando perfil:", error.message);
    res.status(500).json({ error: "No se pudo actualizar el perfil" });
  } finally {
    await session.endSession();
  }
});

// Seguir a otro usuario
app.post("/api/follows/:userId", authenticateToken, async (req, res) => {
  if (
    !ObjectId.isValid(req.auth.sub) ||
    !ObjectId.isValid(req.params.userId)
  ) {
    return res.status(400).json({ error: "Identificador inválido" });
  }

  const followerId = new ObjectId(req.auth.sub);
  const followedId = new ObjectId(req.params.userId);

  if (followerId.equals(followedId)) {
    return res.status(400).json({
      error: "No puedes seguirte a ti mismo"
    });
  }

  const session = client.startSession();
  const eventId = randomUUID();
  const createdAt = new Date();

  try {
    let target = await db.collection("users").findOne(
      { _id: followedId },
      { projection: { _id: 1 } }
    );

    // Si la copia local aún no recibió al usuario, comprobar el perfil en el otro nodo.
    if (!target) {
      try {
        const remoteData = await requestPeerPublicUsers({ userId: followedId.toString() });
        if (remoteData.users.some(user => user.userId === followedId.toString())) {
          target = { _id: followedId };
        }
      } catch (error) {
        console.warn("No se pudo comprobar el usuario remoto antes de seguirlo:", error.message);
      }
    }

    if (!target) {
      return res.status(404).json({
        error: "El usuario que intentas seguir no existe en la red CONIG"
      });
    }

    const existing = await db.collection("follows").findOne({
      followerId,
      followedId
    });

    if (existing) {
      return res.status(409).json({
        error: "Ya sigues a este usuario"
      });
    }

    await session.withTransaction(async () => {
      await db.collection("follows").insertOne({
        followerId,
        followedId,
        sourceRegion: REGION,
        createdAt
      }, { session });

      await db.collection("outbox").insertOne({
        eventId,
        type: "FOLLOW_CREATED",
        sourceRegion: REGION,
        createdAt,
        payload: {
          followerId: followerId.toString(),
          followedId: followedId.toString(),
          createdAt
        }
      }, { session });
    });

    res.status(201).json({
      message: "Ahora sigues a este usuario",
      followerId: followerId.toString(),
      followedId: followedId.toString()
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({
        error: "Ya existe esta relación de seguimiento"
      });
    }

    console.error("Error siguiendo usuario:", error.message);
    res.status(500).json({
      error: "No se pudo seguir al usuario"
    });
  } finally {
    await session.endSession();
  }
});

// Dejar de seguir a otro usuario
app.delete("/api/follows/:userId", authenticateToken, async (req, res) => {
  if (
    !ObjectId.isValid(req.auth.sub) ||
    !ObjectId.isValid(req.params.userId)
  ) {
    return res.status(400).json({ error: "Identificador inválido" });
  }

  const followerId = new ObjectId(req.auth.sub);
  const followedId = new ObjectId(req.params.userId);
  const session = client.startSession();
  const eventId = randomUUID();
  const createdAt = new Date();
  let notFollowing = false;

  try {
    await session.withTransaction(async () => {
      const existing = await db.collection("follows").findOne(
        { followerId, followedId },
        { session }
      );

      if (!existing) {
        notFollowing = true;
        return;
      }

      await db.collection("follows").deleteOne(
        { followerId, followedId },
        { session }
      );

      await db.collection("outbox").insertOne({
        eventId,
        type: "FOLLOW_DELETED",
        sourceRegion: REGION,
        createdAt,
        payload: {
          followerId: followerId.toString(),
          followedId: followedId.toString(),
          createdAt
        }
      }, { session });
    });

    if (notFollowing) {
      return res.status(404).json({
        error: "No sigues a este usuario"
      });
    }

    res.json({
      message: "Has dejado de seguir a este usuario",
      followerId: followerId.toString(),
      followedId: followedId.toString()
    });
  } catch (error) {
    console.error("Error dejando de seguir:", error.message);
    res.status(500).json({
      error: "No se pudo dejar de seguir al usuario"
    });
  } finally {
    await session.endSession();
  }
});

// Consultar usuarios seguidos y seguidores
app.get("/api/follows", authenticateToken, async (req, res) => {
  if (!ObjectId.isValid(req.auth.sub)) {
    return res.status(401).json({
      error: "Identificador de usuario inválido"
    });
  }

  try {
    const userId = new ObjectId(req.auth.sub);

    const [following, followers] = await Promise.all([
      db.collection("follows").find(
        { followerId: userId }
      ).toArray(),
      db.collection("follows").find(
        { followedId: userId }
      ).toArray()
    ]);

    res.json({
      region: REGION,
      following: following.map(item => ({
        userId: item.followedId.toString(),
        createdAt: item.createdAt
      })),
      followers: followers.map(item => ({
        userId: item.followerId.toString(),
        createdAt: item.createdAt
      })),
      followingCount: following.length,
      followersCount: followers.length
    });
  } catch (error) {
    console.error("Error consultando seguimientos:", error.message);
    res.status(500).json({
      error: "No se pudieron consultar los seguimientos"
    });
  }
});




// Obtener los perfiles de las personas que sigue el usuario, incluyendo ambas regiones.
app.get("/api/follows/following-users", authenticateToken, async (req, res) => {
  if (!ObjectId.isValid(req.auth.sub)) {
    return res.status(401).json({ error: "Identificador de usuario inválido" });
  }

  try {
    const userId = new ObjectId(req.auth.sub);
    const relations = await db.collection("follows").find(
      { followerId: userId },
      { projection: { followedId: 1 } }
    ).toArray();
    const followedIds = relations.map(item => item.followedId);
    if (!followedIds.length) {
      return res.json({ total: 0, users: [], partial: false });
    }

    const localUsers = await db.collection("users").find(
      { _id: { $in: followedIds } },
      { projection: { username: 1, displayName: 1, avatarUrl: 1, homeRegion: 1 } }
    ).toArray();
    const usersById = new Map(localUsers.map(user => [user._id.toString(), {
      userId: user._id.toString(),
      username: user.username,
      displayName: user.displayName || null,
      avatarUrl: user.avatarUrl || null,
      homeRegion: user.homeRegion
    }]));

    let partial = false;
    try {
      const remote = await requestPeerPublicUsers();
      const followedSet = new Set(followedIds.map(id => id.toString()));
      for (const person of remote.users || []) {
        if (followedSet.has(person.userId)) usersById.set(person.userId, person);
      }
    } catch (error) {
      partial = true;
      console.warn("No se pudieron consultar todos los perfiles seguidos:", error.message);
    }

    const users = followedIds.map(id => usersById.get(id.toString())).filter(Boolean);
    res.json({ total: users.length, users, partial });
  } catch (error) {
    console.error("Error consultando personas seguidas:", error.message);
    res.status(500).json({ error: "No se pudieron consultar las personas que sigues" });
  }
});


// Consultas firmadas para obtener los perfiles originales del nodo compañero.
async function requestPeerPublicUsers(options = {}) {
  if (!PEER_URL) throw new Error("El nodo compañero no está configurado");

  const requestBody = {
    requestId: randomUUID(),
    requesterRegion: REGION,
    ...options
  };

  const response = await fetch(PEER_URL + "/api/replication/users/query", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-replication-signature": signReplicationBody(requestBody)
    },
    body: JSON.stringify(requestBody),
    signal: AbortSignal.timeout(15000)
  });

  if (!response.ok) {
    throw new Error("El nodo compañero respondió HTTP " + response.status);
  }

  const data = await response.json();
  if (
    data.requestId !== requestBody.requestId ||
    typeof data.sourceRegion !== "string" ||
    !data.sourceRegion ||
    data.sourceRegion === REGION ||
    !Array.isArray(data.users)
  ) {
    throw new Error("Respuesta inválida al consultar perfiles del nodo compañero");
  }

  return data;
}

// Construir el directorio uniendo los perfiles de ambos nodos y priorizando amigos de amigos.
async function buildUserDirectory(currentUserId) {
  const [localUsers, followingRows, followerRows] = await Promise.all([
    db.collection("users").find({}, {
      projection: {
        username: 1,
        displayName: 1,
        bio: 1,
        avatarUrl: 1,
        homeRegion: 1,
        createdAt: 1
      }
    }).sort({ createdAt: -1 }).toArray(),
    db.collection("follows").find(
      { followerId: currentUserId },
      { projection: { followedId: 1 } }
    ).toArray(),
    db.collection("follows").find(
      { followedId: currentUserId },
      { projection: { followerId: 1 } }
    ).toArray()
  ]);

  let remoteUsers = [];
  let partial = false;
  try {
    const remoteData = await requestPeerPublicUsers();
    remoteUsers = remoteData.users;
  } catch (error) {
    partial = true;
    console.warn("Directorio: no se pudo consultar el otro nodo:", error.message);
  }

  const usersById = new Map();
  for (const user of localUsers) {
    usersById.set(user._id.toString(), {
      userId: user._id.toString(),
      username: user.username,
      displayName: user.displayName || null,
      bio: user.bio || "",
      avatarUrl: user.avatarUrl || null,
      homeRegion: user.homeRegion,
      createdAt: user.createdAt
    });
  }
  for (const user of remoteUsers) {
    if (user && user.userId) usersById.set(user.userId, user);
  }

  const followedIds = followingRows.map(item => item.followedId);
  const followingSet = new Set(followedIds.map(id => id.toString()));
  const followedBySet = new Set(followerRows.map(item => item.followerId.toString()));
  const commonCounts = new Map();

  if (followedIds.length) {
    const secondDegree = await db.collection("follows").aggregate([
      {
        $match: {
          followerId: { $in: followedIds },
          followedId: { $ne: currentUserId }
        }
      },
      {
        $group: {
          _id: "$followedId",
          commonConnectionsCount: { $sum: 1 }
        }
      }
    ]).toArray();

    for (const item of secondDegree) {
      commonCounts.set(item._id.toString(), item.commonConnectionsCount);
    }
  }

  const users = [...usersById.values()]
    .filter(user => user.userId !== currentUserId.toString() &&
      !followingSet.has(user.userId) && !followedBySet.has(user.userId))
    .map(user => ({
      ...user,
      isFollowing: followingSet.has(user.userId),
      commonConnectionsCount: commonCounts.get(user.userId) || 0
    }))
    .sort((a, b) => {
      if (b.commonConnectionsCount !== a.commonConnectionsCount) {
        return b.commonConnectionsCount - a.commonConnectionsCount;
      }
      return new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();
    });

  return { users, partial };
}

// Directorio global de perfiles públicos (Bogotá + Cali).
app.get("/api/users", authenticateToken, async (req, res) => {
  if (!ObjectId.isValid(req.auth.sub)) {
    return res.status(401).json({ error: "Identificador de usuario inválido" });
  }

  try {
    const result = await buildUserDirectory(new ObjectId(req.auth.sub));
    res.json({
      region: REGION,
      total: result.users.length,
      partial: result.partial,
      users: result.users
    });
  } catch (error) {
    console.error("Error consultando directorio de usuarios:", error.message);
    res.status(500).json({ error: "No se pudo consultar el directorio de usuarios" });
  }
});

// Consultar un perfil público por identificador.
app.get("/api/users/:userId", authenticateToken, async (req, res) => {
  if (!ObjectId.isValid(req.auth.sub) || !ObjectId.isValid(req.params.userId)) {
    return res.status(400).json({ error: "Identificador de usuario inválido" });
  }

  try {
    const targetId = new ObjectId(req.params.userId);
    const viewerId = new ObjectId(req.auth.sub);
    let user = await db.collection("users").findOne(
      { _id: targetId },
      { projection: { username: 1, displayName: 1, bio: 1, avatarUrl: 1, homeRegion: 1, createdAt: 1 } }
    );

    if (!user) {
      try {
        const remoteData = await requestPeerPublicUsers({ userId: targetId.toString() });
        user = remoteData.users.find(item => item.userId === targetId.toString()) || null;
      } catch (error) {
        console.warn("No se pudo recuperar el perfil remoto:", error.message);
      }
    }

    if (!user) return res.status(404).json({ error: "No se encontró el perfil solicitado" });

    const [followersCount, followingCount, existingFollow] = await Promise.all([
      db.collection("follows").countDocuments({ followedId: targetId }),
      db.collection("follows").countDocuments({ followerId: targetId }),
      db.collection("follows").findOne({ followerId: viewerId, followedId: targetId })
    ]);

    res.json({
      userId: targetId.toString(),
      username: user.username,
      displayName: user.displayName || null,
      bio: user.bio || "",
      avatarUrl: user.avatarUrl || null,
      homeRegion: user.homeRegion,
      createdAt: user.createdAt,
      followersCount,
      followingCount,
      isFollowing: Boolean(existingFollow)
    });
  } catch (error) {
    console.error("Error consultando perfil público:", error.message);
    res.status(500).json({ error: "No se pudo consultar el perfil" });
  }
});

// Consultar las publicaciones de un perfil en los dos nodos.
app.get("/api/users/:userId/posts", authenticateToken, async (req, res) => {
  if (!ObjectId.isValid(req.params.userId)) {
    return res.status(400).json({ error: "Identificador de usuario inválido" });
  }

  try {
    const authorId = new ObjectId(req.params.userId);
    const localPosts = await db.collection("posts")
      .find({ sourceRegion: REGION, authorId })
      .sort({ createdAt: -1 })
      .limit(50)
      .toArray();

    const requestBody = {
      requestId: randomUUID(),
      requesterRegion: REGION,
      authorId: authorId.toString()
    };
    const response = await fetch(PEER_URL + "/api/replication/posts/query", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-replication-signature": signReplicationBody(requestBody)
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(Number(process.env.PEER_TIMEOUT_MS || 75000))
    });

    if (!response.ok) {
      const responseText = await response.text();
      throw new Error("El nodo compañero respondió HTTP " + response.status + ": " + responseText.slice(0, 150));
    }

    const remoteData = await response.json();
    if (
      remoteData.requestId !== requestBody.requestId ||
      typeof remoteData.sourceRegion !== "string" ||
      !remoteData.sourceRegion ||
      remoteData.sourceRegion === REGION ||
      !Array.isArray(remoteData.posts) ||
      remoteData.posts.some(post =>
        post.sourceRegion !== remoteData.sourceRegion ||
        post.authorId !== authorId.toString()
      )
    ) {
      throw new Error("Respuesta inválida de publicaciones del perfil remoto");
    }

    const posts = [...localPosts, ...remoteData.posts]
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, 50);
    const postIds = posts.map(post => post.postId);
    const likeCounts = await db.collection("likes").aggregate([
      { $match: { postId: { $in: postIds } } },
      { $group: { _id: "$postId", count: { $sum: 1 } } }
    ]).toArray();
    const likeCountByPost = new Map(likeCounts.map(item => [item._id, item.count]));

    res.json({
      userId: authorId.toString(),
      total: posts.length,
      posts: posts.map(post => ({
        postId: post.postId,
        authorId: post.authorId.toString(),
        content: post.content,
        imageUrl: post.imageUrl || null,
        likeCount: likeCountByPost.get(post.postId) || 0,
        createdAt: post.createdAt
      }))
    });
  } catch (error) {
    console.error("Error consultando publicaciones del perfil:", error.message);
    res.status(503).json({ error: "No se pudieron consultar las publicaciones de ambas regiones" });
  }
});

// Recomendaciones: primero amigos de amigos y después el resto de usuarios.
app.get("/api/recommendations", authenticateToken, async (req, res) => {
  if (!ObjectId.isValid(req.auth.sub)) {
    return res.status(401).json({ error: "Identificador de usuario inválido" });
  }

  try {
    const result = await buildUserDirectory(new ObjectId(req.auth.sub));
    res.json({
      region: REGION,
      total: result.users.length,
      partial: result.partial,
      recommendations: result.users
    });
  } catch (error) {
    console.error("Error generando recomendaciones:", error.message);
    res.status(500).json({ error: "No se pudieron obtener las recomendaciones" });
  }
});

// Crear una publicación
app.post("/api/posts", authenticateToken, receivePostImageFile, async (req, res) => {
  const content = typeof req.body.content === "string"
    ? req.body.content.trim()
    : "";

  if (content.length < 1 || content.length > 280) {
    return res.status(400).json({
      error: "La publicación debe tener entre 1 y 280 caracteres"
    });
  }

  if (!ObjectId.isValid(req.auth.sub)) {
    return res.status(401).json({
      error: "Identificador de usuario inválido"
    });
  }

  const authorId = new ObjectId(req.auth.sub);
  const postId = randomUUID();
  const createdAt = new Date();
  const session = client.startSession();
  let uploadedImage = null;
  let saved = false;

  try {
    const author = await db.collection("users").findOne(
      { _id: authorId },
      { projection: { username: 1, homeRegion: 1 } }
    );

    if (!author) {
      return res.status(404).json({
        error: "No se encontró el usuario en esta región"
      });
    }

    if (req.file) {
      uploadedImage = await uploadPostImage(req.file, postId);
    }

    const payload = {
      postId,
      authorId: authorId.toString(),
      authorRegion: author.homeRegion,
      content,
      imageUrl: uploadedImage?.imageUrl || null,
      imagePublicId: uploadedImage?.imagePublicId || null,
      createdAt
    };

    await session.withTransaction(async () => {
      await db.collection("posts").insertOne({
        ...payload,
        authorId,
        sourceRegion: REGION
      }, { session });
    });
    saved = true;

    res.status(201).json({
      message: "Publicación creada correctamente",
      post: {
        postId,
        authorId: authorId.toString(),
        authorUsername: author.username,
        authorRegion: author.homeRegion,
        sourceRegion: REGION,
        content,
        imageUrl: payload.imageUrl,
        createdAt
      }
    });
  } catch (error) {
    if (!saved && uploadedImage?.imagePublicId) {
      try {
        await cloudinary.uploader.destroy(
          uploadedImage.imagePublicId,
          { resource_type: "image" }
        );
      } catch (cleanupError) {
        console.error("Error limpiando imagen:", cleanupError.message);
      }
    }

    console.error("Error creando publicación:", error.message);
    res.status(500).json({
      error: "No se pudo crear la publicación"
    });
  } finally {
    await session.endSession();
  }
});


// Consultar las publicaciones disponibles en esta región y adjuntar la identidad del autor.
app.get("/api/posts", authenticateToken, async (req, res) => {
  try {
    const localPosts = await db.collection("posts")
      .find({ sourceRegion: REGION })
      .sort({ createdAt: -1 })
      .limit(50)
      .toArray();

    const requestBody = {
      requestId: randomUUID(),
      requesterRegion: REGION
    };
    const response = await fetch(PEER_URL + "/api/replication/posts/query", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-replication-signature": signReplicationBody(requestBody)
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(Number(process.env.PEER_TIMEOUT_MS || 75000))
    });

    if (!response.ok) {
      const responseText = await response.text();
      throw new Error("El nodo compañero respondió HTTP " + response.status + ": " + responseText.slice(0, 150));
    }

    const remoteData = await response.json();
    if (
      remoteData.requestId !== requestBody.requestId ||
      typeof remoteData.sourceRegion !== "string" ||
      !remoteData.sourceRegion ||
      remoteData.sourceRegion === REGION ||
      !Array.isArray(remoteData.posts) ||
      remoteData.posts.some(post => post.sourceRegion !== remoteData.sourceRegion)
    ) {
      throw new Error("Respuesta inválida del fragmento remoto");
    }

    const combinedPosts = [...localPosts, ...remoteData.posts]
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, 50);

    const currentUserId = new ObjectId(req.auth.sub);
    const postIds = combinedPosts.map(post => post.postId);
    const authorIds = [...new Map(
      combinedPosts
        .filter(post => ObjectId.isValid(post.authorId.toString()))
        .map(post => [post.authorId.toString(), new ObjectId(post.authorId.toString())])
    ).values()];

    const [likeCounts, userLikes, authors] = await Promise.all([
      db.collection("likes").aggregate([
        { $match: { postId: { $in: postIds } } },
        { $group: { _id: "$postId", count: { $sum: 1 } } }
      ]).toArray(),
      db.collection("likes").find({
        postId: { $in: postIds },
        userId: currentUserId
      }, { projection: { postId: 1 } }).toArray(),
      authorIds.length
        ? db.collection("users").find(
            { _id: { $in: authorIds } },
            { projection: { username: 1, displayName: 1, avatarUrl: 1 } }
          ).toArray()
        : Promise.resolve([])
    ]);

    const likeCountByPost = new Map(likeCounts.map(item => [item._id, item.count]));
    const likedPostIds = new Set(userLikes.map(item => item.postId));
    const authorsById = new Map(authors.map(user => [user._id.toString(), user]));

    res.json({
      region: REGION,
      localRegionCount: localPosts.length,
      remoteRegion: remoteData.sourceRegion,
      remoteRegionCount: remoteData.posts.length,
      total: combinedPosts.length,
      posts: combinedPosts.map(post => {
        const authorId = post.authorId.toString();
        const localAuthor = authorsById.get(authorId);
        const author = localAuthor ? {
          userId: localAuthor._id.toString(),
          username: localAuthor.username,
          displayName: localAuthor.displayName || null,
          avatarUrl: localAuthor.avatarUrl || null
        } : (post.author || null);

        return {
          postId: post.postId,
          authorId,
          authorRegion: post.authorRegion,
          sourceRegion: post.sourceRegion,
          author,
          content: post.content,
          imageUrl: post.imageUrl || null,
          likeCount: likeCountByPost.get(post.postId) || 0,
          likedByMe: likedPostIds.has(post.postId),
          createdAt: post.createdAt
        };
      })
    });
  } catch (error) {
    console.error("Error consultando muro distribuido:", error.message);
    res.status(503).json({ error: "No se pudo consultar el muro completo de ambas regiones" });
  }
});

// El autor puede borrar su publicación únicamente durante la primera hora.
app.delete("/api/posts/:postId", authenticateToken, async (req, res) => {
  if (!ObjectId.isValid(req.auth.sub) || typeof req.params.postId !== "string" || !req.params.postId.trim()) {
    return res.status(400).json({ error: "Identificador de publicación inválido" });
  }

  const authorId = new ObjectId(req.auth.sub);
  const postId = req.params.postId;
  const deletedAt = new Date();
  const eventId = randomUUID();
  const session = client.startSession();
  let deletedPost = null;

  try {
    await session.withTransaction(async () => {
      const post = await db.collection("posts").findOne(
        { postId, authorId, sourceRegion: REGION },
        { session }
      );

      if (!post) {
        const error = new Error("No se encontró una publicación propia para eliminar");
        error.statusCode = 404;
        throw error;
      }

      const createdAt = new Date(post.createdAt);
      const elapsed = deletedAt.getTime() - createdAt.getTime();
      if (Number.isNaN(createdAt.getTime()) || elapsed < 0 || elapsed > 60 * 60 * 1000) {
        const error = new Error("Solo puedes borrar una publicación durante la primera hora.");
        error.statusCode = 410;
        throw error;
      }

      deletedPost = post;
      await db.collection("posts").deleteOne({ postId, authorId }, { session });
      await db.collection("likes").deleteMany({ postId }, { session });
      await db.collection("outbox").insertOne({
        eventId,
        type: "POST_DELETED",
        sourceRegion: REGION,
        createdAt: deletedAt,
        payload: {
          postId,
          authorId: authorId.toString(),
          deletedAt
        }
      }, { session });
    });

    if (deletedPost && deletedPost.imagePublicId) {
      try {
        await cloudinary.uploader.destroy(
          deletedPost.imagePublicId,
          { resource_type: "image" }
        );
      } catch (cleanupError) {
        console.error("No se pudo borrar la imagen de Cloudinary:", cleanupError.message);
      }
    }

    return res.json({ message: "Publicación eliminada correctamente", postId });
  } catch (error) {
    console.error("Error eliminando publicación:", error.message);
    return res.status(error.statusCode || 500).json({
      error: error.statusCode ? error.message : "No se pudo eliminar la publicación"
    });
  } finally {
    await session.endSession();
  }
});


// Dar me gusta a una publicación
app.post("/api/likes/:postId", authenticateToken, async (req, res) => {
  const postId = req.params.postId;

  if (
    !ObjectId.isValid(req.auth.sub) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(postId)
  ) {
    return res.status(400).json({ error: "Identificador inválido" });
  }

  const userId = new ObjectId(req.auth.sub);
  const eventId = randomUUID();
  const createdAt = new Date();
  const session = client.startSession();
  let added = false;

  try {
    await session.withTransaction(async () => {
      const result = await db.collection("likes").updateOne(
        { postId, userId },
        {
          $setOnInsert: {
            postId,
            userId,
            sourceRegion: REGION,
            createdAt
          }
        },
        { upsert: true, session }
      );

      added = result.upsertedCount === 1;

      if (added) {
        await db.collection("outbox").insertOne({
          eventId,
          type: "LIKE_CREATED",
          sourceRegion: REGION,
          createdAt,
          payload: {
            postId,
            userId: userId.toString(),
            createdAt
          }
        }, { session });
      }
    });

    res.status(added ? 201 : 200).json({
      message: added ? "Me gusta registrado" : "Ya te gusta esta publicación",
      postId,
      liked: true
    });
  } catch (error) {
    console.error("Error registrando like:", error.message);
    res.status(500).json({ error: "No se pudo registrar el me gusta" });
  } finally {
    await session.endSession();
  }
});

// Quitar me gusta de una publicación
app.delete("/api/likes/:postId", authenticateToken, async (req, res) => {
  const postId = req.params.postId;

  if (
    !ObjectId.isValid(req.auth.sub) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(postId)
  ) {
    return res.status(400).json({ error: "Identificador inválido" });
  }

  const userId = new ObjectId(req.auth.sub);
  const eventId = randomUUID();
  const createdAt = new Date();
  const session = client.startSession();
  let removed = false;

  try {
    await session.withTransaction(async () => {
      const result = await db.collection("likes").deleteOne(
        { postId, userId },
        { session }
      );

      removed = result.deletedCount === 1;

      if (removed) {
        await db.collection("outbox").insertOne({
          eventId,
          type: "LIKE_DELETED",
          sourceRegion: REGION,
          createdAt,
          payload: {
            postId,
            userId: userId.toString(),
            createdAt
          }
        }, { session });
      }
    });

    res.json({
      message: removed ? "Me gusta eliminado" : "No habías indicado que te gusta",
      postId,
      liked: false
    });
  } catch (error) {
    console.error("Error quitando like:", error.message);
    res.status(500).json({ error: "No se pudo quitar el me gusta" });
  } finally {
    await session.endSession();
  }
});

// Enviar un mensaje privado. Si no existe seguimiento mutuo, crea una solicitud.
app.post("/api/messages/:userId", authenticateToken, async (req, res) => {
  if (!ObjectId.isValid(req.auth.sub) || !ObjectId.isValid(req.params.userId)) {
    return res.status(400).json({ error: "Identificador inválido" });
  }

  const content = typeof req.body.content === "string" ? req.body.content.trim() : "";
  if (content.length < 1 || content.length > 2000) {
    return res.status(400).json({ error: "El mensaje debe tener entre 1 y 2000 caracteres" });
  }

  const senderId = new ObjectId(req.auth.sub);
  const recipientId = new ObjectId(req.params.userId);
  if (senderId.equals(recipientId)) {
    return res.status(400).json({ error: "No puedes enviarte mensajes a ti mismo" });
  }

  const recipient = await db.collection("users").findOne(
    { _id: recipientId },
    { projection: { _id: 1, username: 1 } }
  );
  if (!recipient) return res.status(404).json({ error: "No se encontró el destinatario en esta región" });

  const sender = await db.collection("users").findOne(
    { _id: senderId },
    { projection: { _id: 1, username: 1 } }
  );
  if (!sender) return res.status(404).json({ error: "No se encontró el remitente" });

  const conversationId = buildConversationId(senderId, recipientId);
  const messageId = randomUUID();
  const eventId = randomUUID();
  const createdAt = new Date();
  const session = client.startSession();
  let conversationStatus = "accepted";
  let requestedBy = null;
  let resetPendingRequest = false;

  try {
    await session.withTransaction(async () => {
      const existingConversation = await db.collection("conversations").findOne(
        { _id: conversationId },
        { session }
      );

      if (existingConversation) {
        conversationStatus = existingConversation.status || "accepted";
        requestedBy = existingConversation.requestedBy || null;
        if (conversationStatus === "pending" && requestedBy && !requestedBy.equals(senderId)) {
          const clearedMarker = (existingConversation.clearedBy || []).find(item =>
            item.userId && item.userId.equals(senderId)
          );
          const clearedAfterLastMessage = clearedMarker && clearedMarker.clearedAt &&
            new Date(clearedMarker.clearedAt).getTime() >= new Date(existingConversation.lastMessageAt || existingConversation.createdAt).getTime();
          if (clearedAfterLastMessage) {
            resetPendingRequest = true;
            requestedBy = senderId;
          } else {
            const error = new Error("Debes esperar a que la otra persona acepte la solicitud de conversación.");
            error.statusCode = 403;
            throw error;
          }
        }
      } else {
        const senderFollowsRecipient = await db.collection("follows").findOne(
          { followerId: senderId, followedId: recipientId }, { session }
        );
        const recipientFollowsSender = await db.collection("follows").findOne(
          { followerId: recipientId, followedId: senderId }, { session }
        );
        conversationStatus = senderFollowsRecipient && recipientFollowsSender ? "accepted" : "pending";
        requestedBy = conversationStatus === "pending" ? senderId : null;
      }

      const conversationUpdate = {
        $setOnInsert: {
          _id: conversationId,
          participantIds: [senderId, recipientId],
          createdAt,
          status: conversationStatus,
          requestedBy
        },
        $max: { lastMessageAt: createdAt }
      };
      if (resetPendingRequest) {
        conversationUpdate.$set = { status: "pending", requestedBy: senderId };
      }
      await db.collection("conversations").updateOne(
        { _id: conversationId },
        conversationUpdate,
        { upsert: true, session }
      );

      await db.collection("messages").insertOne({
        messageId,
        conversationId,
        senderId,
        recipientId,
        senderRegion: REGION,
        content,
        createdAt,
        deliveryStatus: "sent",
        deliveredAt: null,
        readAt: null
      }, { session });

      await db.collection("outbox").insertOne({
        eventId,
        type: "MESSAGE_SENT",
        sourceRegion: REGION,
        createdAt,
        payload: {
          messageId,
          conversationId,
          senderId: senderId.toString(),
          recipientId: recipientId.toString(),
          senderRegion: REGION,
          content,
          createdAt,
          conversationStatus,
          requestedBy: requestedBy ? requestedBy.toString() : null
        }
      }, { session });
    });

    res.status(201).json({
      message: conversationStatus === "pending"
        ? "Solicitud de conversación enviada"
        : "Mensaje enviado correctamente",
      data: {
        messageId,
        conversationId,
        senderId: senderId.toString(),
        recipientId: recipientId.toString(),
        recipientUsername: recipient.username,
        content,
        deliveryStatus: "sent",
        status: conversationStatus,
        requestedBy: requestedBy ? requestedBy.toString() : null,
        createdAt
      }
    });
  } catch (error) {
    console.error("Error enviando mensaje:", error.message);
    res.status(error.statusCode || 500).json({
      error: error.statusCode === 403 ? error.message : "No se pudo enviar el mensaje"
    });
  } finally {
    await session.endSession();
  }
});

// Consultar conversaciones con foto, estado, mensajes sin leer y borrado individual.
app.get("/api/conversations", authenticateToken, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.auth.sub)) {
      return res.status(401).json({ error: "Identificador de usuario inválido" });
    }
    const userId = new ObjectId(req.auth.sub);
    const conversations = await db.collection("conversations")
      .find({ participantIds: userId })
      .sort({ lastMessageAt: -1 })
      .limit(100)
      .toArray();

    const mapped = await Promise.all(conversations.map(async conversation => {
      const otherId = conversation.participantIds.find(id => !id.equals(userId));
      const otherUser = otherId ? await db.collection("users").findOne(
        { _id: otherId },
        { projection: { username: 1, displayName: 1, avatarUrl: 1, homeRegion: 1 } }
      ) : null;
      const marker = (conversation.clearedBy || []).find(item => item.userId && item.userId.equals(userId));
      const visibleFilter = { conversationId: conversation._id };
      if (marker && marker.clearedAt) visibleFilter.createdAt = { $gt: marker.clearedAt };
      const [lastMessage, unreadCount] = await Promise.all([
        db.collection("messages").findOne(visibleFilter, { sort: { createdAt: -1 } }),
        db.collection("messages").countDocuments({
          ...visibleFilter,
          recipientId: userId,
          deliveryStatus: { $ne: "read" }
        })
      ]);
      if (!lastMessage) return null;
      return {
        conversationId: conversation._id,
        participant: otherUser ? {
          userId: otherId.toString(),
          username: otherUser.username,
          displayName: otherUser.displayName || null,
          avatarUrl: otherUser.avatarUrl || null,
          homeRegion: otherUser.homeRegion
        } : null,
        lastMessage: {
          messageId: lastMessage.messageId,
          senderId: lastMessage.senderId.toString(),
          content: lastMessage.content,
          deliveryStatus: lastMessage.deliveryStatus,
          createdAt: lastMessage.createdAt
        },
        status: conversation.status || "accepted",
        requestedBy: conversation.requestedBy ? conversation.requestedBy.toString() : null,
        unreadCount,
        lastMessageAt: conversation.lastMessageAt || conversation.createdAt
      };
    }));

    const result = mapped.filter(Boolean);
    res.json({
      region: REGION,
      total: result.length,
      unreadTotal: result.reduce((sum, item) => sum + item.unreadCount, 0),
      conversations: result
    });
  } catch (error) {
    console.error("Error consultando conversaciones:", error.message);
    res.status(500).json({ error: "No se pudieron consultar las conversaciones" });
  }
});

// Consultar el historial privado, respetando la fecha de borrado individual.
app.get("/api/conversations/:conversationId/messages", authenticateToken, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.auth.sub)) {
      return res.status(401).json({ error: "Identificador de usuario inválido" });
    }
    const userId = new ObjectId(req.auth.sub);
    const conversationId = req.params.conversationId;
    const conversation = await db.collection("conversations").findOne({
      _id: conversationId,
      participantIds: userId
    });
    if (!conversation) {
      return res.status(404).json({ error: "Conversación inexistente o no tienes permiso para verla" });
    }

    const marker = (conversation.clearedBy || []).find(item => item.userId && item.userId.equals(userId));
    const filter = { conversationId };
    if (marker && marker.clearedAt) filter.createdAt = { $gt: marker.clearedAt };
    const requestedLimit = Number.parseInt(req.query.limit, 10);
    const limit = Number.isInteger(requestedLimit) ? Math.max(1, Math.min(requestedLimit, 100)) : 50;
    const messages = await db.collection("messages").find(filter)
      .sort({ createdAt: -1 }).limit(limit).toArray();

    res.json({
      conversationId,
      region: REGION,
      total: messages.length,
      status: conversation.status || "accepted",
      requestedBy: conversation.requestedBy ? conversation.requestedBy.toString() : null,
      messages: messages.reverse().map(message => ({
        messageId: message.messageId,
        senderId: message.senderId.toString(),
        recipientId: message.recipientId.toString(),
        content: message.content,
        deliveryStatus: message.deliveryStatus,
        createdAt: message.createdAt,
        deliveredAt: message.deliveredAt,
        readAt: message.readAt
      }))
    });
  } catch (error) {
    console.error("Error consultando historial:", error.message);
    res.status(500).json({ error: "No se pudo consultar el historial" });
  }
});

// Aceptar una solicitud recibida. Solo puede aceptarla la persona destinataria.
app.patch("/api/conversations/:conversationId/accept", authenticateToken, async (req, res) => {
  if (!ObjectId.isValid(req.auth.sub)) {
    return res.status(401).json({ error: "Identificador de usuario inválido" });
  }
  const userId = new ObjectId(req.auth.sub);
  const conversationId = req.params.conversationId;
  const acceptedAt = new Date();
  const eventId = randomUUID();
  const session = client.startSession();
  let alreadyAccepted = false;

  try {
    await session.withTransaction(async () => {
      const conversation = await db.collection("conversations").findOne(
        { _id: conversationId, participantIds: userId }, { session }
      );
      if (!conversation) {
        const error = new Error("No se encontró la solicitud de conversación");
        error.statusCode = 404;
        throw error;
      }
      if ((conversation.status || "accepted") === "accepted") {
        alreadyAccepted = true;
        return;
      }
      if (!conversation.requestedBy || conversation.requestedBy.equals(userId)) {
        const error = new Error("Solo la persona que recibió la solicitud puede aceptarla");
        error.statusCode = 403;
        throw error;
      }

      // Aceptar la conversación no crea relaciones de seguimiento.
      await db.collection("conversations").updateOne(
        { _id: conversationId },
        { $set: { status: "accepted", acceptedBy: userId, acceptedAt } },
        { session }
      );
      await db.collection("outbox").insertOne({
        eventId,
        type: "CONVERSATION_ACCEPTED",
        sourceRegion: REGION,
        createdAt: acceptedAt,
        payload: { conversationId, acceptedBy: userId.toString(), acceptedAt }
      }, { session });
    });

    res.json({
      message: alreadyAccepted ? "La conversación ya estaba aceptada" : "Conversación aceptada",
      status: "accepted"
    });
  } catch (error) {
    console.error("Error aceptando conversación:", error.message);
    res.status(error.statusCode || 500).json({
      error: error.statusCode ? error.message : "No se pudo aceptar la conversación"
    });
  } finally {
    await session.endSession();
  }
});

// Borrar el chat solo para la persona que realiza la acción.
app.delete("/api/conversations/:conversationId", authenticateToken, async (req, res) => {
  if (!ObjectId.isValid(req.auth.sub)) {
    return res.status(401).json({ error: "Identificador de usuario inválido" });
  }
  const userId = new ObjectId(req.auth.sub);
  const conversationId = req.params.conversationId;
  const clearedAt = new Date();
  const eventId = randomUUID();
  const session = client.startSession();

  try {
    await session.withTransaction(async () => {
      const conversation = await db.collection("conversations").findOne(
        { _id: conversationId, participantIds: userId }, { session }
      );
      if (!conversation) {
        const error = new Error("No se encontró la conversación");
        error.statusCode = 404;
        throw error;
      }
      const marker = (conversation.clearedBy || []).find(item => item.userId && item.userId.equals(userId));
      if (marker) {
        await db.collection("conversations").updateOne(
          { _id: conversationId, "clearedBy.userId": userId },
          { $set: { "clearedBy.$.clearedAt": clearedAt } },
          { session }
        );
      } else {
        await db.collection("conversations").updateOne(
          { _id: conversationId },
          { $push: { clearedBy: { userId, clearedAt } } },
          { session }
        );
      }
      await db.collection("outbox").insertOne({
        eventId,
        type: "CONVERSATION_CLEARED",
        sourceRegion: REGION,
        createdAt: clearedAt,
        payload: { conversationId, userId: userId.toString(), clearedAt }
      }, { session });
    });

    res.json({ message: "Chat borrado para tu cuenta" });
  } catch (error) {
    console.error("Error borrando chat:", error.message);
    res.status(error.statusCode || 500).json({
      error: error.statusCode ? error.message : "No se pudo borrar el chat"
    });
  } finally {
    await session.endSession();
  }
});

// Notificaciones de mensajes no leídos y solicitudes de conversación pendientes.
app.get("/api/message-notifications", authenticateToken, async (req, res) => {
  if (!ObjectId.isValid(req.auth.sub)) {
    return res.status(401).json({ error: "Identificador de usuario inválido" });
  }
  try {
    const userId = new ObjectId(req.auth.sub);
    const conversations = await db.collection("conversations").find({ participantIds: userId })
      .sort({ lastMessageAt: -1 }).limit(100).toArray();
    const notifications = [];

    for (const conversation of conversations) {
      const marker = (conversation.clearedBy || []).find(item => item.userId && item.userId.equals(userId));
      const unreadFilter = {
        conversationId: conversation._id,
        recipientId: userId,
        deliveryStatus: { $ne: "read" }
      };
      if (marker && marker.clearedAt) unreadFilter.createdAt = { $gt: marker.clearedAt };
      const visibleMessageFilter = { conversationId: conversation._id };
      if (marker && marker.clearedAt) visibleMessageFilter.createdAt = { $gt: marker.clearedAt };
      const [lastVisibleMessage, unreadMessage, unreadCount] = await Promise.all([
        db.collection("messages").findOne(visibleMessageFilter, { sort: { createdAt: -1 } }),
        db.collection("messages").findOne(unreadFilter, { sort: { createdAt: -1 } }),
        db.collection("messages").countDocuments(unreadFilter)
      ]);
      const pendingRequest = (conversation.status || "accepted") === "pending" &&
        conversation.requestedBy && !conversation.requestedBy.equals(userId) &&
        lastVisibleMessage && lastVisibleMessage.senderId.equals(conversation.requestedBy);
      if (!unreadCount && !pendingRequest) continue;

      const actorId = pendingRequest
        ? conversation.requestedBy
        : (unreadMessage ? unreadMessage.senderId : null);
      if (!actorId) continue;
      const actor = await db.collection("users").findOne(
        { _id: actorId },
        { projection: { username: 1, displayName: 1, avatarUrl: 1 } }
      );
      if (!actor) continue;
      notifications.push({
        conversationId: conversation._id,
        participant: {
          userId: actorId.toString(),
          username: actor.username,
          displayName: actor.displayName || null,
          avatarUrl: actor.avatarUrl || null
        },
        pendingRequest: Boolean(pendingRequest),
        unreadCount,
        createdAt: unreadMessage ? unreadMessage.createdAt : conversation.createdAt
      });
    }

    res.json({
      total: notifications.length,
      unreadTotal: notifications.reduce((sum, item) => sum + item.unreadCount, 0),
      notifications
    });
  } catch (error) {
    console.error("Error consultando notificaciones de mensajes:", error.message);
    res.status(500).json({ error: "No se pudieron consultar las notificaciones" });
  }
});

// Marcar un mensaje recibido como leído. Se ejecuta automáticamente al abrir el chat.
app.patch("/api/messages/:messageId/read", authenticateToken, async (req, res) => {
  if (!ObjectId.isValid(req.auth.sub)) {
    return res.status(401).json({ error: "Identificador de usuario inválido" });
  }
  const recipientId = new ObjectId(req.auth.sub);
  const messageId = req.params.messageId;
  const eventId = randomUUID();
  const readAt = new Date();
  const session = client.startSession();
  let message;
  let alreadyRead = false;

  try {
    await session.withTransaction(async () => {
      message = await db.collection("messages").findOne({ messageId, recipientId }, { session });
      if (!message) return;
      if (message.deliveryStatus === "read") {
        alreadyRead = true;
        return;
      }
      if (!message.deliveredAt) {
        const error = new Error("El mensaje todavía no está entregado");
        error.statusCode = 409;
        throw error;
      }
      await db.collection("messages").updateOne(
        { messageId, recipientId },
        { $set: { deliveryStatus: "read", readAt } },
        { session }
      );
      await db.collection("outbox").insertOne({
        eventId,
        type: "MESSAGE_READ",
        sourceRegion: REGION,
        createdAt: readAt,
        payload: {
          messageId,
          conversationId: message.conversationId,
          senderId: message.senderId.toString(),
          recipientId: recipientId.toString(),
          deliveredAt: message.deliveredAt,
          readAt
        }
      }, { session });
    });

    if (!message) return res.status(404).json({ error: "No se encontró un mensaje recibido por este usuario" });
    res.json({
      message: alreadyRead ? "El mensaje ya estaba marcado como leído" : "Mensaje marcado como leído",
      messageId,
      deliveryStatus: "read",
      readAt: message.readAt || readAt
    });
  } catch (error) {
    console.error("Error marcando mensaje como leído:", error.message);
    res.status(error.statusCode || 500).json({
      error: error.statusCode === 409 ? error.message : "No se pudo marcar el mensaje como leído"
    });
  } finally {
    await session.endSession();
  }
});

// Enviar eventos de auditoría a MongoDB Atlas.
// Este proceso es independiente de la replicación entre regiones.
let auditRunning = false;
let atlasClient = null;

async function dispatchPendingAuditEvents() {
  if (!db || auditRunning || !process.env.ATLAS_URI) return;

  auditRunning = true;

  try {
    if (!atlasClient) {
      const candidate = new MongoClient(process.env.ATLAS_URI, {
        serverSelectionTimeoutMS: 5000
      });

      try {
        await candidate.connect();
        atlasClient = candidate;
        console.log("Conexión de auditoría con MongoDB Atlas establecida");
      } catch (error) {
        await candidate.close().catch(() => {});
        throw error;
      }
    }

    const atlasEvents = atlasClient
      .db("red_social_triggers")
      .collection("trigger_events");

    const pendingEvents = await db.collection("outbox").find({
      type: {
        $in: [
          "USER_REGISTERED",
          "USER_PROFILE_UPDATED",
          "FOLLOW_CREATED",
          "FOLLOW_DELETED",
          "MESSAGE_SENT",
          "MESSAGE_DELIVERED",
          "MESSAGE_READ"
        ]
      },
      auditDeliveredAt: { $exists: false },
      $or: [
        { auditNextAttemptAt: { $exists: false } },
        { auditNextAttemptAt: { $lte: new Date() } }
      ]
    })
      .sort({ createdAt: 1 })
      .limit(20)
      .toArray();

    for (const event of pendingEvents) {
      const original = event.payload || {};
      let payload = {};

      // Construimos una carga segura: nunca copiamos el payload completo.
      if (event.type === "USER_REGISTERED") {
        payload = {
          userId: original.userId ? String(original.userId) : null,
          username: original.username || null
        };
      }

      if (event.type === "USER_PROFILE_UPDATED") {
        payload = {
          userId: original.userId ? String(original.userId) : null
        };
      }

      if (
        event.type === "FOLLOW_CREATED" ||
        event.type === "FOLLOW_DELETED"
      ) {
        payload = {
          followerId: original.followerId
            ? String(original.followerId)
            : null,
          followedId: original.followedId
            ? String(original.followedId)
            : null
        };
      }

      if (
        event.type === "MESSAGE_SENT" ||
        event.type === "MESSAGE_DELIVERED" ||
        event.type === "MESSAGE_READ"
      ) {
        payload = {
          messageId: original.messageId
            ? String(original.messageId)
            : null,
          conversationId: original.conversationId
            ? String(original.conversationId)
            : null,
          senderId: original.senderId
            ? String(original.senderId)
            : null,
          recipientId: original.recipientId
            ? String(original.recipientId)
            : null
        };
      }

      const auditEvent = {
        _id: String(event.eventId),
        eventId: String(event.eventId),
        type: event.type,
        sourceRegion: event.sourceRegion || REGION,
        occurredAt: event.createdAt || new Date(),
        payload
      };

      try {
        await atlasEvents.insertOne(auditEvent);

        await db.collection("outbox").updateOne(
          { eventId: event.eventId },
          {
            $set: {
              auditDeliveredAt: new Date(),
              auditDeliveredTo: "MongoDB Atlas"
            },
            $unset: {
              auditNextAttemptAt: "",
              auditLastError: ""
            }
          }
        );

        console.log(
          `Auditoría enviada a Atlas: ${event.type} (${event.eventId})`
        );

      } catch (error) {
        // Si ya existe, la inserción anterior pudo completarse
        // aunque se perdiera su confirmación de red.
        if (error.code === 11000) {
          await db.collection("outbox").updateOne(
            { eventId: event.eventId },
            {
              $set: {
                auditDeliveredAt: new Date(),
                auditDeliveredTo: "MongoDB Atlas"
              }
            }
          );

          continue;
        }

        await db.collection("outbox").updateOne(
          { eventId: event.eventId },
          {
            $inc: { auditAttempts: 1 },
            $set: {
              auditLastError: error.message.slice(0, 250),
              auditNextAttemptAt: new Date(Date.now() + 30000)
            }
          }
        );

        console.error(
          `Auditoría pendiente (${event.type}):`,
          error.message
        );

        break;
      }
    }

  } catch (error) {
    console.error(
      "Atlas no disponible; se reintentará la auditoría:",
      error.message
    );
  } finally {
    auditRunning = false;
  }
}

// Enviar eventos pendientes al otro servidor
async function replicatePendingEvents() {
  if (!db || replicationRunning) return;

  replicationRunning = true;

  try {
    const pendingEvents = await db.collection("outbox").find({
      type: {
        $in: [
          "USER_REGISTERED",
          "USER_PROFILE_UPDATED",
          "FOLLOW_CREATED",
          "FOLLOW_DELETED",
          "LIKE_CREATED",
          "LIKE_DELETED",
          "MESSAGE_SENT",
          "MESSAGE_DELIVERED",
          "MESSAGE_READ",
          "CONVERSATION_ACCEPTED",
          "CONVERSATION_CLEARED",
          "POST_DELETED",
          "ADMIN_ROLE_UPDATED"
        ]
      },
      deliveredAt: { $exists: false },
      failedAt: { $exists: false },
      $or: [
        {
          type: "USER_REGISTERED",
          "payload.passwordHash": { $type: "string" }
        },
        {
          type: "USER_PROFILE_UPDATED",
          "payload.userId": { $type: "string" },
          "payload.homeRegion": { $type: "string" },
          "payload.updatedAt": { $exists: true }
        },
        {
          type: "ADMIN_ROLE_UPDATED",
          "payload.userId": { $type: "string" },
          "payload.role": { $in: ["admin", "user"] }
        },
        {
          type: "POST_DELETED",
          "payload.postId": { $type: "string" },
          "payload.authorId": { $type: "string" }
        },
        {
          type: { $in: ["FOLLOW_CREATED", "FOLLOW_DELETED"] },
          "payload.followerId": { $type: "string" },
          "payload.followedId": { $type: "string" }
        },
        {
          type: { $in: ["LIKE_CREATED", "LIKE_DELETED"] },
          "payload.postId": { $type: "string" },
          "payload.userId": { $type: "string" }
        },
        {
          type: {
            $in: ["MESSAGE_SENT", "MESSAGE_DELIVERED", "MESSAGE_READ"]
          },
          "payload.messageId": { $type: "string" },
          "payload.conversationId": { $type: "string" },
          "payload.senderId": { $type: "string" },
          "payload.recipientId": { $type: "string" }
        },
        {
          type: "CONVERSATION_ACCEPTED",
          "payload.conversationId": { $type: "string" },
          "payload.acceptedBy": { $type: "string" }
        },
        {
          type: "CONVERSATION_CLEARED",
          "payload.conversationId": { $type: "string" },
          "payload.userId": { $type: "string" }
        }
      ]
    })
      .sort({ createdAt: 1 })
      .limit(20)
      .toArray();

    for (const event of pendingEvents) {
      const body = {
        eventId: event.eventId,
        type: event.type,
        sourceRegion: event.sourceRegion,
        payload: event.payload
      };

      try {
        const response = await fetch(
          `${PEER_URL}/api/replication/${["USER_REGISTERED", "USER_PROFILE_UPDATED"].includes(event.type) ? "users" : ["FOLLOW_CREATED", "FOLLOW_DELETED"].includes(event.type) ? "follows" : ["LIKE_CREATED", "LIKE_DELETED"].includes(event.type) ? "likes" : ["CONVERSATION_ACCEPTED", "CONVERSATION_CLEARED"].includes(event.type) ? "conversations" : event.type === "POST_DELETED" ? "posts" : event.type === "ADMIN_ROLE_UPDATED" ? "admins" : "messages"}`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-replication-signature": signReplicationBody(body)
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(Number(process.env.PEER_TIMEOUT_MS || 75000))
          }
        );

        if (response.ok) {
          await db.collection("outbox").updateOne(
            { eventId: event.eventId },
            {
              $set: {
                deliveredAt: new Date(),
                deliveredTo: PEER_URL
              }
            }
          );

          console.log(
            `Evento replicado: ${event.eventId} hacia ${PEER_URL}`
          );

          continue;
        }

        const responseText = await response.text();

        if (response.status === 409) {
          await db.collection("outbox").updateOne(
            { eventId: event.eventId },
            {
              $set: {
                failedAt: new Date(),
                replicationError: responseText
              }
            }
          );

          console.error(
            `Conflicto de replicación en ${event.eventId}`
          );

          continue;
        }

        console.error(
          `Replicación pendiente. HTTP ${response.status}: ${responseText.slice(0, 150)}`
        );

        break;
      } catch (error) {
        console.error(
          `No se pudo conectar con ${PEER_URL}:`,
          error.message
        );

        break;
      }
    }
  } catch (error) {
    console.error("Error revisando outbox:", error.message);
  } finally {
    replicationRunning = false;
  }
}

// Configuración inicial: designar exactamente dos cuentas existentes como administradoras.
// Requiere ADMIN_BOOTSTRAP_SECRET en Render. La ruta se bloquea cuando ya existe un admin.
app.post("/api/admin/bootstrap", async (req, res) => {
  const configuredSecret = process.env.ADMIN_BOOTSTRAP_SECRET || "";
  const suppliedSecret = req.get("x-admin-bootstrap-key") || "";

  if (!configuredSecret) {
    return res.status(503).json({ error: "El bootstrap administrativo no está habilitado" });
  }

  const expected = Buffer.from(configuredSecret);
  const received = Buffer.from(suppliedSecret);
  if (
    !suppliedSecret ||
    expected.length !== received.length ||
    !timingSafeEqual(expected, received)
  ) {
    return res.status(401).json({ error: "Clave de configuración inválida" });
  }

  try {
    const existingAdmins = await db.collection("users").countDocuments({ role: "admin" });
    if (existingAdmins > 0) {
      return res.status(409).json({ error: "La configuración inicial ya fue completada" });
    }

    const usernames = Array.isArray(req.body?.usernames)
      ? req.body.usernames.map(value => String(value || "").trim().toLowerCase())
      : [];

    if (
      usernames.length !== 2 ||
      usernames.some(username => !/^[a-z0-9_]{3,20}$/.test(username)) ||
      new Set(usernames).size !== 2
    ) {
      return res.status(400).json({ error: "Indica dos nombres de usuario distintos y válidos" });
    }

    const admins = await db.collection("users").find({
      username: { $in: usernames }
    }, {
      projection: { _id: 1, username: 1, homeRegion: 1 }
    }).toArray();

    if (admins.length !== 2) {
      return res.status(404).json({
        error: "No se encontraron las dos cuentas. Primero deben estar registradas en CONIG."
      });
    }

    const session = client.startSession();
    const updatedAt = new Date();
    try {
      await session.withTransaction(async () => {
        for (const user of admins) {
          await db.collection("users").updateOne(
            { _id: user._id },
            { $set: { role: "admin", roleUpdatedAt: updatedAt } },
            { session }
          );

          await db.collection("outbox").insertOne({
            eventId: randomUUID(),
            type: "ADMIN_ROLE_UPDATED",
            sourceRegion: REGION,
            createdAt: updatedAt,
            payload: {
              userId: user._id.toString(),
              role: "admin",
              updatedAt
            }
          }, { session });
        }
      });
    } finally {
      await session.endSession();
    }

    return res.status(201).json({
      message: "Administradores iniciales configurados",
      administrators: admins.map(user => ({
        username: user.username,
        homeRegion: user.homeRegion
      }))
    });
  } catch (error) {
    console.error("Error en configuración inicial de administradores:", error.message);
    return res.status(500).json({ error: "No se pudo completar la configuración inicial" });
  }
});

// Consulta interna firmada: devuelve únicamente métricas agregadas de la región.
app.post("/api/replication/admin/overview", async (req, res) => {
  const body = req.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return res.status(400).json({ error: "Solicitud inválida" });
  }

  const signature = req.get("x-replication-signature") || "";
  const received = Buffer.from(signature, "hex");
  const expected = Buffer.from(signReplicationBody(body), "hex");
  if (
    !/^[a-f0-9]{64}$/i.test(signature) ||
    received.length !== expected.length ||
    !timingSafeEqual(received, expected)
  ) {
    return res.status(401).json({ error: "Firma inválida" });
  }

  if (
    typeof body.requestId !== "string" || !body.requestId ||
    !["bogota", "cali"].includes(body.requesterRegion) ||
    body.requesterRegion === REGION
  ) {
    return res.status(400).json({ error: "Consulta de métricas inválida" });
  }

  try {
    const [postsTotal, followsTotal, conversationsTotal] = await Promise.all([
      db.collection("posts").countDocuments({ sourceRegion: REGION }),
      db.collection("follows").countDocuments({}),
      db.collection("conversations").countDocuments({})
    ]);

    res.json({
      requestId: body.requestId,
      sourceRegion: REGION,
      postsTotal,
      followsTotal,
      conversationsTotal
    });
  } catch (error) {
    console.error("Error consultando métricas regionales:", error.message);
    res.status(500).json({ error: "No se pudieron consultar las métricas regionales" });
  }
});

// Todas las rutas siguientes exigen el rol admin almacenado en MongoDB.
app.get("/api/admin/overview", authenticateToken, requireAdmin, async (req, res) => {
  try {
    const [usersTotal, adminsTotal, localPosts, followsTotal, conversationsTotal] = await Promise.all([
      db.collection("users").countDocuments({}),
      db.collection("users").countDocuments({ role: "admin" }),
      db.collection("posts").countDocuments({ sourceRegion: REGION }),
      db.collection("follows").countDocuments({}),
      db.collection("conversations").countDocuments({})
    ]);

    let peer = null;
    let partial = false;
    try {
      const requestBody = { requestId: randomUUID(), requesterRegion: REGION };
      const response = await fetch(PEER_URL + "/api/replication/admin/overview", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-replication-signature": signReplicationBody(requestBody)
        },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(Number(process.env.PEER_TIMEOUT_MS || 75000))
      });

      if (!response.ok) throw new Error("HTTP " + response.status);
      const data = await response.json();
      if (data.requestId !== requestBody.requestId || data.sourceRegion === REGION) {
        throw new Error("Respuesta regional inválida");
      }
      peer = data;
    } catch (error) {
      partial = true;
      console.warn("No se pudieron consultar las métricas del nodo compañero:", error.message);
    }

    res.json({
      region: REGION,
      usersTotal,
      adminsTotal,
      postsTotal: localPosts + (peer?.postsTotal || 0),
      postsByRegion: {
        [REGION]: localPosts,
        ...(peer ? { [peer.sourceRegion]: peer.postsTotal } : {})
      },
      followsTotal,
      conversationsTotal,
      partial
    });
  } catch (error) {
    console.error("Error consultando panel administrativo:", error.message);
    res.status(500).json({ error: "No se pudieron consultar las estadísticas administrativas" });
  }
});

app.get("/api/admin/users", authenticateToken, requireAdmin, async (req, res) => {
  try {
    const search = String(req.query.search || "").trim().toLowerCase();
    const escapedSearch = [...search].map(char =>
      "\\^$.*+?()[]{}|".includes(char) ? "\\" + char : char
    ).join("");
    const filter = search
      ? {
          $or: [
            { username: { $regex: escapedSearch, $options: "i" } },
            { email: { $regex: escapedSearch, $options: "i" } },
            { displayName: { $regex: escapedSearch, $options: "i" } }
          ]
        }
      : {};

    const users = await db.collection("users").find(filter, {
      projection: {
        username: 1,
        email: 1,
        displayName: 1,
        avatarUrl: 1,
        homeRegion: 1,
        role: 1,
        createdAt: 1
      }
    }).sort({ createdAt: -1 }).limit(500).toArray();

    res.json({
      total: users.length,
      users: users.map(user => ({
        userId: user._id.toString(),
        username: user.username,
        email: user.email,
        displayName: user.displayName || null,
        avatarUrl: user.avatarUrl || null,
        homeRegion: user.homeRegion,
        role: user.role || "user",
        createdAt: user.createdAt
      }))
    });
  } catch (error) {
    console.error("Error consultando usuarios administrativos:", error.message);
    res.status(500).json({ error: "No se pudo consultar la lista de usuarios" });
  }
});

app.patch("/api/admin/users/:userId/role", authenticateToken, requireAdmin, async (req, res) => {
  if (!ObjectId.isValid(req.params.userId)) {
    return res.status(400).json({ error: "Identificador de usuario inválido" });
  }

  const targetId = new ObjectId(req.params.userId);
  const role = req.body?.role;
  if (!["admin", "user"].includes(role)) {
    return res.status(400).json({ error: "El rol debe ser admin o user" });
  }

  if (targetId.equals(req.adminUserId)) {
    return res.status(400).json({ error: "No puedes cambiar tu propio rol" });
  }

  const updatedAt = new Date();
  const eventId = randomUUID();
  const session = client.startSession();

  try {
    let target = null;
    await session.withTransaction(async () => {
      target = await db.collection("users").findOne({ _id: targetId }, { session });
      if (!target) {
        const error = new Error("No se encontró el usuario");
        error.statusCode = 404;
        throw error;
      }

      if (role === "user" && target.role === "admin") {
        const adminCount = await db.collection("users").countDocuments({ role: "admin" }, { session });
        if (adminCount <= 1) {
          const error = new Error("Debe permanecer al menos un administrador activo");
          error.statusCode = 409;
          throw error;
        }
      }

      if ((target.role || "user") === role) return;

      await db.collection("users").updateOne(
        { _id: targetId },
        { $set: { role, roleUpdatedAt: updatedAt } },
        { session }
      );

      await db.collection("outbox").insertOne({
        eventId,
        type: "ADMIN_ROLE_UPDATED",
        sourceRegion: REGION,
        createdAt: updatedAt,
        payload: { userId: targetId.toString(), role, updatedAt }
      }, { session });
    });

    res.json({
      message: role === "admin" ? "Administrador agregado correctamente" : "Permisos administrativos retirados",
      userId: targetId.toString(),
      role
    });
  } catch (error) {
    console.error("Error actualizando rol de usuario:", error.message);
    res.status(error.statusCode || 500).json({
      error: error.statusCode ? error.message : "No se pudo actualizar el rol del usuario"
    });
  } finally {
    await session.endSession();
  }
});


// Iniciar servidor
async function startServer() {
  try {
    await client.connect();
    db = client.db(MONGO_DB);

    await db.collection("users").createIndex(
      { username: 1 },
      { unique: true }
    );

    await db.collection("users").createIndex(
      { email: 1 },
      { unique: true }
    );

    await db.collection("processed_events").createIndex(
      { eventId: 1 },
      { unique: true }
    );

    await db.collection("posts").createIndex(
      { postId: 1 },
      { unique: true }
    );

    await db.collection("posts").createIndex(
      { createdAt: -1 }
    );

    await db.collection("follows").createIndex(
      { followerId: 1, followedId: 1 },
      { unique: true }
    );

    await db.collection("follows").createIndex(
      { followedId: 1 }
    );

    await db.collection("likes").createIndex(
      { postId: 1, userId: 1 },
      { unique: true }
    );

    await db.collection("likes").createIndex(
      { postId: 1 }
    );

    await db.collection("conversations").createIndex(
      { participantIds: 1, lastMessageAt: -1 }
    );

    await db.collection("messages").createIndex(
      { messageId: 1 },
      { unique: true }
    );

    await db.collection("messages").createIndex(
      { conversationId: 1, createdAt: 1 }
    );

    await db.collection("outbox").createIndex(
      { eventId: 1 },
      { unique: true }
    );

    console.log(`MongoDB conectado: ${REGION}`);

    const port = Number(PORT) || 3000;

    app.listen(
      port,
      process.env.BIND_HOST || "127.0.0.1",
      () => {
        console.log(`Servidor activo: ${REGION}, puerto ${port}`);
        console.log(`Nodo compañero: ${PEER_URL}`);

        replicatePendingEvents();
        setInterval(replicatePendingEvents, 2000);

        dispatchPendingAuditEvents();
        setInterval(dispatchPendingAuditEvents, 10000);
      }
    );
  } catch (error) {
    console.error("Error al iniciar el servidor:", error.message);
    process.exit(1);
  }
}

startServer();

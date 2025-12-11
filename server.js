require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const twilio = require("twilio");
const admin = require("firebase-admin");

// Inicializar Firebase Admin
admin.initializeApp({
  credential: admin.credential.cert({
    private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    client_email: process.env.FIREBASE_CLIENT_EMAIL,
    project_id: process.env.FIREBASE_PROJECT_ID
  }),
  databaseURL: process.env.FIREBASE_DB_URL
});

const db = admin.database();

// Inicializar Twilio
const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());


// -----------------------------------------------
// WEBHOOK
// -----------------------------------------------
app.post("/webhook-twilio", async (req, res) => {

  const body = req.body;
  const from = body.From.replace("whatsapp:", "");
  const msgType = body.MessageType;
  const text = body.Body ? body.Body.toLowerCase().trim() : "";

  console.log("MENSAJE RECIBIDO:", body);

  // Buscar empleado
  // const empleadoSnap = await db.ref(`empleados/${from}`).once("value");
    const empleadoSnap = await db.ref(`empleados/${from}`).once("value");

  if (!empleadoSnap.exists()) {
    console.log("Número no registrado:", from);
    await sendMessage(from, "❌ Tu número no está registrado.");
    return res.sendStatus(200);
  }

  const empleado = empleadoSnap.val();
  console.log("Empleado encontrado:", empleado.nombre);
  // -----------------------------------------------
  // PROCESAR MENSAJES DE TEXTO
  // -----------------------------------------------
  if (msgType === "text") {
    if (text === "entrada" || text === "salida") {
      console.log(`Registrando ${text} para ${empleado.nombre}`);
      await registrar(empleado, from, text.toUpperCase());
      await sendMessage(from, `✅ Tu ${text} ha sido registrada.`);
      return res.sendStatus(200);
    }

    await sendMessage(from, "⚠️ Envía *entrada* o *salida*.");
    return res.sendStatus(200);

  }

  // -----------------------------------------------
  // PROCESAR UBICACIÓN
  // -----------------------------------------------
  if (msgType === "location") {
    const lat = parseFloat(body.Latitude);
    const lng = parseFloat(body.Longitude);

    // Buscar empresa
    const empresaSnap = await db.ref(`empresas/${empleado.empresaId}`).once("value");

    if (!empresaSnap.exists()) {
      await sendMessage(from, "❌ La empresa no tiene ubicación configurada.");
      return res.sendStatus(200);
    }

    const empresa = empresaSnap.val();

    const distancia = calcularDistancia(lat, lng, empresa.lat, empresa.lng);

    if (distancia > 80) {
      await sendMessage(
        from,
        `❌ Estás fuera de rango.\nDistancia: ${distancia.toFixed(2)}m\nMáximo permitido: 80m`
      );
      return res.sendStatus(200);
    }

    // Registrar ubicación válida
    await registrar(empleado, from, "UBICACIÓN", { lat, lng, distancia });

    await sendMessage(
      from,
      `📍 Ubicación registrada.\nDistancia: ${distancia.toFixed(2)}m`
    );
    return res.sendStatus(200);
  }

  res.sendStatus(200);
});


// -----------------------------------------------------
// FUNCIONES
// -----------------------------------------------------
async function registrar(empleado, numero, tipo, extra = {}) {
  console.log(`Registrando ${tipo} para ${empleado.nombre}`);
  await db.ref("checadas").push({
    numero,
    empleado: empleado.nombre,
    empresaId: empleado.empresaId,
    tipo,
    extra,
    fecha: Date.now()
  });
}

async function sendMessage(to, msg) {
  try {
    console.log("Enviando mensaje a", to, ":", msg);
    await client.messages.create({
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to: `whatsapp:${to}`,
      body: msg
    });
  } catch (e) {
    console.error("Error enviando mensaje:", e);
  }
}

function calcularDistancia(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const rad = Math.PI / 180;

  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) *
    Math.sin(dLon / 2) ** 2;

  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}


// -----------------------------------------------
// LEVANTAR SERVIDOR LOCAL
// -----------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(process.env.TWILIO_WHATSAPP_NUMBER)
  console.log("Servidor Node corriendo en puerto", PORT);
});

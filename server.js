process.env.TZ = 'America/Mexico_City';

require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const twilio = require("twilio");
const admin = require("firebase-admin");

// -----------------------------------------------
// FIREBASE ADMIN
// -----------------------------------------------
admin.initializeApp({
  credential: admin.credential.cert({
    private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    client_email: process.env.FIREBASE_CLIENT_EMAIL,
    project_id: process.env.FIREBASE_PROJECT_ID
  }),
  databaseURL: process.env.FIREBASE_DB_URL
});

const db = admin.database();

// -----------------------------------------------
// TWILIO
// -----------------------------------------------
const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// -----------------------------------------------
// EXPRESS
// -----------------------------------------------
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// -----------------------------------------------
// WEBHOOK TWILIO
// -----------------------------------------------
app.post("/webhook-twilio", async (req, res) => {
try {
  const body = req.body;
  const from = body.From.replace("whatsapp:", "");
  const msgType = body.MessageType;
  const text = body.Body ? body.Body.toLowerCase().trim() : "";

  console.log("MENSAJE RECIBIDO:", body);
  console.log(from);
  console.log(text);
  // Buscar empleado por número
  const empleadoSnap = await db.ref(`empleados/${from}`).once("value");

  if (!empleadoSnap.exists()) {
    console.log("❌ Tu número no está registrado.");
    await sendMessage(from, "❌ Tu número no está registrado.");
    return res.sendStatus(200);
  }

  const empleado = empleadoSnap.val();
  console.log("Empleado:", empleado.nombre);
  console.log(msgType);

  if (msgType === "text") {
    console.log("Entro");
    if (text === "entrada" || text === "salida") {
      console.log("Entrada o salida");
      await registrar(empleado, from, text.toUpperCase());
      await sendMessage(from, `✅ Tu ${text} ha sido registrada.`);
      return res.sendStatus(200);
    }

    console.log("envio de mensaje de entrada o salida");
    await sendMessage(from, "⚠️ Envía *entrada* o *salida* o comparte tu ubicación.");
    return res.sendStatus(200);
  }
  console.log("Iniciamos la ubicación");

 /* if (msgType === "location") {

    const lat = parseFloat(body.Latitude);
    const lng = parseFloat(body.Longitude);
    const accuracy = body.Accuracy ? parseFloat(body.Accuracy) : null;
    console.log("Ubicación del usuario lat:" +lat +" y lng" +lng );
    // Validar coordenadas
    if (isNaN(lat) || isNaN(lng)) {
       console.log("❌ Ubicación inválida. Intenta de nuevo.");
      await sendMessage(from, "❌ Ubicación inválida. Intenta de nuevo.");
      return res.sendStatus(200);
    }

    // 🔒 Anti GPS impreciso (opcional)
    if (accuracy && accuracy > 40) {
      await sendMessage(
        from,
        `❌ GPS impreciso (${accuracy} m).\nActiva ubicación precisa e inténtalo nuevamente.`
      );
      return res.sendStatus(200);
    }

    console.log("Toma valores de la empresa");
    // Obtener empresa
    const empresaSnap = await db.ref(`empresa/${empleado.empresaId}`).once("value");

    if (!empresaSnap.exists()) {
         console.log("❌ La empresa no tiene ubicación configurada.");
      await sendMessage(from, "❌ La empresa no tiene ubicación configurada.");
      return res.sendStatus(200);
    }

    const empresa = empresaSnap.val();

    if (!empresa.lat || !empresa.lng) {
      console.log("❌ Coordenadas de la empresa inválidas.");
      await sendMessage(from, "❌ Coordenadas de la empresa inválidas.");
      return res.sendStatus(200);
    }

    // Calcular distancia
    console.log("Inicia a calcular distancia");
    const distancia = calcularDistancia(lat, lng, empresa.lat, empresa.lng);

    console.log(`Distancia: ${distancia} metros`);

    // ❌ FUERA DE RANGO
    if (distancia > 80) {
      console.log("Fuera del rango de distancia")
      await sendMessage(
        from,
        `❌ Estás fuera del rango permitido.\n\n📏 Distancia actual: ${distancia.toFixed(2)} m\n📍 Máximo permitido: 80 m\n\n👉 Acércate más a la empresa para registrar tu checada.`
      );
      return res.sendStatus(200);
    }

    console.log("✅ REGISTRAR CHECADA");
    // ✅ REGISTRAR CHECADA
    await registrar(empleado, from, "UBICACION", {
      lat,
      lng,
      distancia: distancia.toFixed(2),
      accuracy
    });

    console.log("✅ Envia mensaje de validación");
    await sendMessage(
      from,
      `✅ Ubicación validada.\n📏 Distancia: ${distancia.toFixed(2)} m`
    );

    return res.sendStatus();
  }*/

  //res.sendStatus();
}catch(error){
  console.log(error.message);
}
});

// ===============================
// ENDPOINT DE PRUEBA LOCAL
// ===============================
app.post('/debug/checada', async (req, res) => {
  try {
    const { numero, lat, lng, tipo } = req.body;

    console.log('🧪 DEBUG REQUEST:', req.body);

    if (!numero || !lat || !lng) {
      return res.status(400).json({ error: 'Faltan datos' });
    }

    // Buscar empleado
    const empleadoSnap = await db.ref(`empleados/${numero}`).once('value');
    if (!empleadoSnap.exists()) {
      return res.status(404).json({ error: 'Empleado no registrado' });
    }

    const empleado = empleadoSnap.val();

    // Buscar empresa
    const empresaSnap = await db.ref(`empresa/${empleado.empresaId}`).once('value');
    if (!empresaSnap.exists()) {
      return res.status(404).json({ error: 'Empresa sin ubicación' });
    }

    const empresa = empresaSnap.val();

    // Calcular distancia
    const distancia = calcularDistancia(lat, lng, empresa.lat, empresa.lng);

    console.log(`📏 Distancia calculada: ${distancia.toFixed(2)} m`);

    // VALIDACIÓN DE RADIO
    if (distancia > 80) {
      return res.status(403).json({
        ok: false,
        message: 'Debes acercarte más a la empresa',
        distancia: distancia.toFixed(2)
      });
    }

    // Registrar checada
    await registrar(empleado, numero, tipo || 'TEST', {
      lat,
      lng,
      distancia
    });

    return res.json({
      ok: true,
      message: 'Checada registrada correctamente',
      distancia: distancia.toFixed(2)
    });

  } catch (err) {
    console.error('❌ ERROR DEBUG:', err);
    res.status(500).json({ error: err.message });
  }
});

// -----------------------------------------------
// REGISTRAR CHECADA
// -----------------------------------------------
async function registrar(empleado, numero, tipo, extra = {}) {

  const fecha = new Date();
  const horaMX = fecha.toLocaleString("es-MX", {
    timeZone: "America/Mexico_City"
  });

  await db.ref("checadas").push({
    numero,
    empleado: empleado.nombre,
    empresaId: empleado.empresaId,
    tipo,
    extra,
    timestamp: Date.now(),
    dia: `${fecha.getFullYear()}-${fecha.getMonth() + 1}-${fecha.getDate()}`,
    hora: horaMX.split(",")[1]
  });
}

// -----------------------------------------------
// ENVIAR WHATSAPP
// -----------------------------------------------
async function sendMessage(to, msg) {
  try {
     const message = await client.messages.create({
      body: msg,
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to: `whatsapp:${to}`
    });
  } catch (e) {
    console.error("Error Twilio:", e.message);
  }
}

// -----------------------------------------------
// CALCULAR DISTANCIA (HAVERSINE)
// -----------------------------------------------
function calcularDistancia(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const rad = Math.PI / 180;

  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) *
    Math.cos(lat2 * rad) *
    Math.sin(dLon / 2) ** 2;

  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// -----------------------------------------------
// SERVIDOR
// -----------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Servidor corriendo en puerto", PORT);
});

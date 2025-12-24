process.env.TZ = 'America/Mexico_City'; 

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
    return res.sendStatus();
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
      return res.sendStatus();
    }

    // await sendMessage(from, "⚠️ Envía *entrada* o *salida*.");
    // return res.sendStatus(200);

  }

  // -----------------------------------------------
  // PROCESAR UBICACIÓN
  // -----------------------------------------------
  if (msgType === "location") {
    const lat = parseFloat(body.Latitude);
    const lng = parseFloat(body.Longitude);
     const accuracy = body.Accuracy ? parseFloat(body.Accuracy) : null;

     // Validar coordenadas
    if (isNaN(lat) || isNaN(lng)) {
      await sendMessage(from, "❌ Ubicación inválida. Intenta de nuevo.");
      return res.sendStatus();
    }

    // 🔒 Anti GPS impreciso (opcional)
    if (accuracy && accuracy > 40) {
      await sendMessage(
        from,
        `❌ GPS impreciso (${accuracy} m).\nActiva ubicación precisa e inténtalo nuevamente.`
      );
      return res.sendStatus();
    }

    // Buscar empresa
    const empresaSnap = await db.ref(`empresa/${empleado.empresaId}`).once("value");

    if (!empresaSnap.exists()) {
      await sendMessage(from, "❌ La empresa no tiene ubicación configurada.");
      return res.sendStatus();
    }

    const empresa = empresaSnap.val();
    if (!empresa.lat || !empresa.lng) {
      await sendMessage(from, "❌ Coordenadas de la empresa inválidas.");
      return res.sendStatus();
    }

    const distancia = calcularDistancia(lat, lng, empresa.lat, empresa.lng);
 
    console.log(`Distancia: ${distancia} metros`);

    if (distancia > 80) {
      await sendMessage(
        from,
        `❌ Estás fuera de rango.\nDistancia: ${distancia.toFixed(2)}m\nMáximo permitido: 80m`
      );
      return res.sendStatus();
    }

     // ✅ REGISTRAR CHECADA
    // Registrar ubicación válida
    //await registrar(empleado, from, "UBICACIÓN", { lat, lng, distancia });
        // ✅ REGISTRAR CHECADA
      await registrar(empleado, from, "UBICACION", {
        lat,
        lng,
        distancia: distancia.toFixed(2),
        accuracy
      });

    await sendMessage(
      from,
      `📍 Ubicación registrada.\nDistancia: ${distancia.toFixed(2)}m`
    );
    return res.sendStatus();
  }

  res.sendStatus();
});


// -----------------------------------------------------
// FUNCIONES
// -----------------------------------------------------
async function registrar(empleado, numero, tipo, extra = {}) {
  console.log(`Registrando ${tipo} para ${empleado.nombre}`);
  const fechaHora = new Date();
  console.log(fechaHora.getFullYear(), fechaHora.getMonth() + 1, fechaHora.getDate(), fechaHora.getHours(), fechaHora.getMinutes(), fechaHora.getSeconds());
  const timestampInSeconds = Math.floor(Date.now() / 1000);
  console.log(timestampInSeconds);

  const fecha = new Date();
  const horaGDL = fecha.toLocaleString("es-MX", {
    timeZone: "America/Mexico_City"
  });
    console.log(horaGDL);
  // const hour = fechaHora.getHours().toString().padStart(2, '0');
  //   const min = fechaHora.getMinutes().toString().padStart(2, '0');
  //   const sec = fechaHora.getSeconds().toString().padStart(2, '0');
  // const timestampInSeconds = Math.floor(Date.now() / 1000);
  await db.ref("checadas").push({
    numero,
    empleado: empleado.nombre,
    empresaId: empleado.empresaId,  
    tipo,
    extra,
    fecha: Date.now(),
    dia: fechaHora.getFullYear()+'-'+ (fechaHora.getMonth() + 1) +'-'+ fechaHora.getDate(),
    fechaHora:horaGDL.split(',')[1]//fechahora:  admin.database.ServerValue.TIMESTAMP // ✅ servidor Firebase
  });
}

async function sendMessage(to, msg) {
  try {
    console.log("Enviando mensaje a", to, ":", msg);
    // await client.messages.create({
    //   from: process.env.TWILIO_WHATSAPP_NUMBER,
    //   to: `whatsapp:${to}`,
    //   body: msg
    // });
      const message = await client.messages.create({
    body: msg,
    from: process.env.TWILIO_WHATSAPP_NUMBER,
    to: `whatsapp:${to}`
  }); 

  } catch (e) {
       console.log("ERROR Twilio:");
    console.log("status:", e.status);
    console.log("code:", e.code);
    console.log("message:", e.message);
    console.log("moreInfo:", e.moreInfo);
    //console.error("Error enviando mensaje:", e);
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

process.env.TZ = 'America/Mexico_City';

require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const admin = require("firebase-admin");
const crypto = require("crypto");
const cors = require("cors");
const fetch = require("node-fetch");

// -----------------------------------------------
// FIREBASE
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
// EXPRESS
// -----------------------------------------------
const app = express();
app.use(bodyParser.json());
app.use(cors());

// -----------------------------------------------
// UTILS
// -----------------------------------------------
function generarToken() {
  return crypto.randomBytes(24).toString("hex");
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
// WEBHOOK VERIFY
// -----------------------------------------------
app.get("/webhook-whatsapp", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// -----------------------------------------------
// WEBHOOK MENSAJES
// -----------------------------------------------
app.post("/webhook-whatsapp", async (req, res) => {
  try {
    
    const body = req.body;

    console.log("Body recibido:", JSON.stringify(body, null, 2));

    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const messageObj = value?.messages?.[0];

    if (!messageObj) {
      console.log("No hay mensaje");
      return res.sendStatus(200);
    }
    //const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    //if (!message) return res.sendStatus(200);
    const from = `+${messageObj.from}`;           // número sin whatsapp:
    const msgType = messageObj.type;        // text, location, image, etc.

    //const from = message.from;
    const type = messageObj.type;  
    let message = "";

    if (msgType === "text") {
      message = messageObj.text.body.toLowerCase().trim();
    }

    console.log("Tipo de mensaje:", msgType);
    console.log("Contenido del mensaje:", message);
    console.log("Número:", from);

    const empleadoSnap = await db.ref(`empleados/${from}`).once("value");
    if (!empleadoSnap.exists()) {
      console.log("Número no registrado:", from);
      await sendWhatsAppMessage(from, "❌ Tu número no está registrado.");
      return res.sendStatus(200);
    }
console.log("Empleado encontrado para el número:", from);
    const empleado = empleadoSnap.val();

    console.log("tipo de mensaje:", type);
    if (type === "text") {
      const text = messageObj.text.body.toLowerCase().trim();;

      if (text === "entrada" || text === "salida") {
        console.log(`Iniciando checada de tipo: ${text.toUpperCase()}`);
        await iniciarChecada(from, empleado, text.toUpperCase());
      }else {
        await sendWhatsAppMessage(
          from,
          "❌ Comando no reconocido. Envía 'ENTRADA' o 'SALIDA' para registrar tu checada."
        );
      }
    }

    res.sendStatus(200);
  } catch (e) {
    console.error(e);
    res.sendStatus(500);
  }
});

// -----------------------------------------------
// INICIAR CHECADA
// -----------------------------------------------
async function iniciarChecada(numero, empleado, tipo) {
  console.log(`Generando token para ${numero} (${tipo})`);
  const token = generarToken();
  const expiraEn = Date.now() + 2 * 60 * 1000;

  await db.ref(`tokens/${token}`).set({
    numero,
    empresaId: empleado.empresaId,
    tipo,
    expiraEn
  });

  //const link = `https://tudominio.com/checkin.html?token=${token}`;
   const link = `https://checador-7bc7c.web.app/checkin.html?token=${token}`;
console.log(`Enlace generado: ${link}`);
  await sendWhatsAppMessage(
    numero,
    `📍 Para registrar tu *${tipo}*, abre el enlace:\n${link}\n⏱️ Expira en 2 minutos`
  );
}

// -----------------------------------------------
// CHECKIN DESDE WEBAPP
// -----------------------------------------------
app.post("/checkin", async (req, res) => {
  try {
    const { token, lat, lng, accuracy } = req.body;

    if (!token || !lat || !lng) {
      return res.status(400).json({ mensaje: "Datos incompletos" });
    }

    if (accuracy > 400) {
      return res.status(403).json({ mensaje: "GPS impreciso" });
    }

    const tSnap = await db.ref(`tokens/${token}`).once("value");
    if (!tSnap.exists()) {
      return res.status(403).json({ mensaje: "Token inválido" });
    }

    const t = tSnap.val();

    if (Date.now() > t.expiraEn) {
      await db.ref(`tokens/${token}`).remove();
      return res.status(403).json({ mensaje: "Token expirado" });
    }

    const empresaSnap = await db.ref(`empresa/${t.empresaId}`).once("value");
    const empresa = empresaSnap.val();

    const distancia = calcularDistancia(
      lat,
      lng,
      empresa.lat,
      empresa.lng
    );

    if (distancia > empresa.radioMetros) {
      return res.status(403).json({ mensaje: "Fuera de rango" });
    }

    await db.ref("checadas").push({
      numero: t.numero,
      empresaId: t.empresaId,
      tipo: t.tipo,
      timestamp: Date.now(),
      ubicacion: { lat, lng, accuracy, distancia }
    });

    await db.ref(`tokens/${token}`).remove();

    await sendWhatsAppMessage(
      t.numero,
      `✅ ${t.tipo} registrada correctamente`
    );

    res.json({ mensaje: "Checada registrada" });

  } catch (e) {
    console.error(e);
    res.status(500).json({ mensaje: "Error interno" });
  }
});

// -----------------------------------------------
// ENVIAR WHATSAPP
// -----------------------------------------------
async function sendWhatsAppMessage(to, text) {
    try {
      console.log("Bearing token:", process.env.WHATSAPP_TOKEN);
          await fetch(
          
            `https://graph.facebook.com/v17.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
                "Content-Type": "application/json"
              },
              body: JSON.stringify({
                messaging_product: "whatsapp",
                to,
                text: { body: text }
              })
            }
          );
  }catch (error) {
    console.error("Error enviando mensaje WhatsApp:", error);
  }
}

// -----------------------------------------------
app.listen(3000, () =>
  console.log("Servidor corriendo en puerto 3000")
);

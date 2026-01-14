


app.get('/webhook-whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }

  res.sendStatus(403);
});


app.post('/webhook-whatsapp', async (req, res) => {
  const entry = req.body.entry?.[0];
  const changes = entry?.changes?.[0];
  const value = changes?.value;
  const message = value?.messages?.[0];

  if (!message) return res.sendStatus(200);

  const from = message.from;
  const type = message.type;

  console.log('MENSAJE:', JSON.stringify(message, null, 2));

  // Buscar empleado
  const empleadoSnap = await db.ref(`empleados/${from}`).once('value');

  if (!empleadoSnap.exists()) {
    await sendWhatsAppMessage(from, '❌ Tu número no está registrado.');
    return res.sendStatus(200);
  }

  const empleado = empleadoSnap.val();

  // TEXTO
  if (type === 'text') {
    const text = message.text.body.toLowerCase().trim();

    if (text === 'entrada' || text === 'salida') {
      await iniciarChecada(from, empleado, text.toUpperCase());
    }
  }

  // UBICACIÓN (solo si decides permitirla)
  if (type === 'location') {
    await sendWhatsAppMessage(
      from,
      '⚠️ Para registrar tu checada abre el enlace que se te envió.'
    );
  }

  res.sendStatus(200);
});

const crypto = require('crypto');

function generarToken() {
  return crypto.randomBytes(24).toString('hex');
}

async function iniciarChecada(numero, empleado, tipo) {
  const token = generarToken();
  const expiraEn = Date.now() + 2 * 60 * 1000;

  await db.ref(`tokens/${token}`).set({
    numero,
    empleadoId: empleado.id || numero,
    empresaId: empleado.empresaId,
    tipo,
    expiraEn
  });

  const link = `https://tudominio.com/checkin.html?token=${token}`;

  await sendWhatsAppMessage(
    numero,
    `📍 Para registrar tu *${tipo}*, abre el enlace:\n${link}\n\n⏱️ Expira en 2 minutos`
  );
}

async function sendWhatsAppMessage(to, text) {
  await fetch(
    `https://graph.facebook.com/v19.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        text: { body: text }
      })
    }
  );
}


    app.post('/checkin', /*upload.single('selfie'),*/ async (req, res) => {
      try {
        console.log("CHECKIN REQUEST:", req.body);
        const { token, lat, lng, accuracy } = req.body;
        //if (!req.file) return res.status(403).json({ mensaje: 'Selfie obligatoria' });
        if (accuracy > 30) return res.status(403).json({ mensaje: 'GPS impreciso' });

        const tSnap = await db.ref(`tokens/${token}`).once('value');
        if (!tSnap.exists()) return res.status(400).json({ mensaje: 'Token inválido' });

        const t = tSnap.val();
        if (Date.now() > t.expira) return res.status(403).json({ mensaje: 'Token expirado' });

        const cfg = (await db.ref(`diaslaborales/${t.empresaId}`).once('value')).val();
        const turnos = (await db.ref(`turnos/${t.empresaId}`).once('value')).val();

        const ahora = new Date();
        const horaActual = ahora.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });

        const turno = detectarTurno(horaActual, turnos);
        if (!turno) return res.status(403).json({ mensaje: 'Fuera de turno' });

        const distancia = calcularDistancia(lat, lng, cfg.ubicacion.lat, cfg.ubicacion.lng);
        if (distancia > cfg.ubicacion.radioMetros) {
          return res.status(403).json({ mensaje: 'Fuera de rango' });
        }

        const fuera = fueraDeTolerancia(
          horaActual,
          t.tipo === 'ENTRADA' ? turno.entrada : turno.salida,
          cfg.tiempoTolerancia

        );

        // await db.ref('checadas').push({
        //   numero: t.numero,
        //   empresaId: t.empresaId,
        //   tipo: t.tipo,
        //   turno: turno.id,
        //   hora: horaActual,
        //   distancia,
        //   accuracy,
        //   fueraTolerancia: fuera,
        //   timestamp: Date.now()
        // });
        const fecha = new Date();
        const horaMX = fecha.toLocaleString("es-MX", {
          timeZone: "America/Mexico_City"
        });

        await db.ref("checadas").push({
          numero: t.numero,
          empleado: empleado.nombre,
          empresaId: t.empresaId,
          tipo: t.tipo,
          timestamp: Date.now(),
          turno: turno.id,
          hora: horaActual,
          distancia,
          accuracy,
          fueraTolerancia: fuera,
          dia: `${fecha.getFullYear()}-${fecha.getMonth() + 1}-${fecha.getDate()}`,
          hora: horaMX.split(",")[1],
          ubicacion: {
          lat, lng, accuracy, distancia
        }
        });

        await db.ref(`tokens/${token}`).remove();
        // res.json({ mensaje: 'Checada registrada' });

        // después de registrar checada
        await sendWhatsApp(
          t.numero,
          fuera
            ? `⏰ ${t.tipo} fuera de horario.\n✍️ Indica el motivo por WhatsApp.`
            : `✅ ${t.tipo} registrada correctamente\n🕒 ${horaActual}`
        );
        return res.status(200).json({ mensaje: "Checada registrada" });
      } catch (e) {
        console.log(e);
        res.status(500).json({ mensaje: "Error interno" });
      }
      //res.json({ mensaje: "Checada registrada" });
    });
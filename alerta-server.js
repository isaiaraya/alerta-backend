const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const admin = require('firebase-admin');
const { v4: uuidv4 } = require('uuid');

admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.PROJECT_ID,
    clientEmail: process.env.CLIENT_EMAIL,
    privateKey: process.env.PRIVATE_KEY.replace(/\\n/g, '\n'),
  }),
});

const db = admin.firestore();
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());

// 🔧 Normaliza los números
function limpiarNumero(numero) {
  let limpio = numero.replace(/\D/g, '');
  if (limpio.startsWith('56')) limpio = limpio.slice(2);
  if (limpio.startsWith('9') && limpio.length === 9) return limpio;
  return null;
}

// ✅ Ruta POST para crear alerta y enviar notificación FCM
app.post('/api/emergencias', async (req, res) => {
  const { senderName, senderPhone, message, location, contacts } = req.body;

  if (!contacts || !Array.isArray(contacts)) {
    return res.status(400).json({ success: false, message: 'Lista de contactos inválida.' });
  }

  const senderLimpio = limpiarNumero(senderPhone);
  if (!senderLimpio) {
    return res.status(400).json({ success: false, message: 'Número del remitente inválido.' });
  }

  const remitenteSnapshot = await db
    .collection('usuarios')
    .where('telefono', '==', senderLimpio)
    .get();

  if (remitenteSnapshot.empty) {
    return res.status(403).json({
      success: false,
      message: 'El remitente no está registrado en la base de datos.',
    });
  }

  const emisorDoc = remitenteSnapshot.docs[0];
  const contactosRegistrados = [];

  // Generar un único ID para toda la alerta (emisor y destinatarios)
  const alertaIdUnico = uuidv4();

  for (const numero of contacts) {
    const limpio = limpiarNumero(numero);
    if (!limpio) continue;

    const contactoSnapshot = await db
      .collection('usuarios')
      .where('telefono', '==', limpio)
      .get();

    if (!contactoSnapshot.empty) {
      const userDoc = contactoSnapshot.docs[0];
      const nombreContacto = userDoc.data().nombre || limpio;

      const alertaParaContacto = {
        id: alertaIdUnico, // Mismo ID para todos
        senderName,
        senderPhone: senderLimpio,
        emisor: senderLimpio,
        destinatario: limpio,
        message,
        location,
        timestamp: new Date().toISOString(),
        estado: 'activa',
      };

      await db
        .collection('usuarios')
        .doc(userDoc.id)
        .collection('alertas_recibidas')
        .doc(alertaIdUnico) // Mismo ID aquí
        .set(alertaParaContacto);

      contactosRegistrados.push({
        id: userDoc.id,
        nombre: nombreContacto,
        telefono: limpio,
      });

      const fcmToken = userDoc.data().fcmToken;

      if (fcmToken && typeof fcmToken === 'string') {
        const messagePayload = {
          token: fcmToken,
          notification: {
            title: `🚨 Alerta de ${senderName}`,
            body: message || '¡Tienes una nueva alerta!',
          },
          data: {
            alertaId: alertaIdUnico,
            senderPhone: senderLimpio,
            click_action: 'FLUTTER_NOTIFICATION_CLICK',
          },
          android: {
            priority: 'high',
            notification: {
              sound: 'default',
              click_action: 'FLUTTER_NOTIFICATION_CLICK',
            },
          },
          apns: {
            payload: {
              aps: {
                sound: 'default',
                alert: {
                  title: `🚨 Alerta de ${senderName}`,
                  body: message || '¡Tienes una nueva alerta!',
                },
                category: 'RESPONDER_ALERTA',
              },
            },
          },
        };

        try {
          await admin.messaging().send(messagePayload);
        } catch (error) {
          console.error(`❌ Error enviando notificación a ${nombreContacto}:`, error.message);
        }
      }
    }
  }

  // Almacena alerta para el emisor con el mismo ID
  if (contactosRegistrados.length > 0) {
    const alertaParaEmisor = {
      id: alertaIdUnico,
      senderName,
      senderPhone: senderLimpio,
      emisor: senderLimpio,
      destinatarios: contactosRegistrados,
      message,
      location,
      timestamp: new Date().toISOString(),
      estado: 'activa',
    };

    await db
      .collection('usuarios')
      .doc(emisorDoc.id)
      .collection('alertas_enviadas')
      .doc(alertaIdUnico) // mismo ID
      .set(alertaParaEmisor);
  }

  return res.status(200).json({
    success: true,
    registrados: contactosRegistrados.length,
    noRegistrados: contacts.length - contactosRegistrados.length,
    detalles: contactosRegistrados,
  });
});

// ✅ Ruta GET para obtener alertas
app.get('/api/emergencias/:telefono', async (req, res) => {
  const telefonoParam = limpiarNumero(req.params.telefono);
  if (!telefonoParam) {
    return res.status(400).json({ success: false, message: 'Número inválido.' });
  }

  const usuarioSnapshot = await db
    .collection('usuarios')
    .where('telefono', '==', telefonoParam)
    .get();

  if (usuarioSnapshot.empty) {
    return res.status(404).json({ success: false, message: 'Usuario no encontrado.' });
  }

  const userId = usuarioSnapshot.docs[0].id;

  const [recibidasSnapshot, enviadasSnapshot] = await Promise.all([
    db.collection('usuarios').doc(userId).collection('alertas_recibidas').orderBy('timestamp', 'desc').get(),
    db.collection('usuarios').doc(userId).collection('alertas_enviadas').orderBy('timestamp', 'desc').get(),
  ]);

  const alertasRecibidas = recibidasSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  const alertasEnviadas = enviadasSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

  return res.status(200).json({
    success: true,
    telefono: telefonoParam,
    recibidas: alertasRecibidas,
    enviadas: alertasEnviadas,
  });
});

// ✅ Ruta PUT para finalizar una alerta y sus copias en los destinatarios
app.put('/api/emergencias/finalizar/:id', async (req, res) => {
  const alertaId = req.params.id;

  try {
    const usuariosSnapshot = await db.collection('usuarios').get();
    let encontrada = false;

    for (const usuarioDoc of usuariosSnapshot.docs) {
      const userId = usuarioDoc.id;
      const usuarioRef = db.collection('usuarios').doc(userId);

      const [alertaEnviadaSnap, alertaRecibidaSnap] = await Promise.all([
        usuarioRef.collection('alertas_enviadas').doc(alertaId).get(),
        usuarioRef.collection('alertas_recibidas').doc(alertaId).get(),
      ]);

      if (alertaEnviadaSnap.exists) {
        const alertaEnviada = alertaEnviadaSnap.data();
        await alertaEnviadaSnap.ref.update({ estado: 'finalizada' });
        encontrada = true;

        const destinatarios = alertaEnviada.destinatarios || [];

        for (const d of destinatarios) {
          const telefonoDestinatario = d.telefono;

          const destSnap = await db
            .collection('usuarios')
            .where('telefono', '==', telefonoDestinatario)
            .get();

          if (!destSnap.empty) {
            const destDoc = destSnap.docs[0];
            const recibidasRef = db.collection('usuarios').doc(destDoc.id).collection('alertas_recibidas');

            const alertaQuery = await recibidasRef
              .where('senderPhone', '==', alertaEnviada.senderPhone)
              .where('estado', '==', 'activa')
              .get();

            for (const alertaDoc of alertaQuery.docs) {
              await alertaDoc.ref.update({ estado: 'finalizada' });
            }
          }
        }
      }

      if (alertaRecibidaSnap.exists) {
        await alertaRecibidaSnap.ref.update({ estado: 'finalizada' });
        encontrada = true;
      }
    }

    if (encontrada) {
      return res.json({
        success: true,
        message: '✅ Alerta finalizada correctamente para emisor y destinatarios.',
      });
    } else {
      return res.status(404).json({ success: false, message: '❌ Alerta no encontrada.' });
    }
  } catch (error) {
    console.error('Error al finalizar alerta:', error);
    return res.status(500).json({ success: false, message: '❌ Error al finalizar alerta.' });
  }
});

app.listen(PORT, () => {
  console.log(`🚨 Servidor de emergencias activo en http://localhost:${PORT}`);
});

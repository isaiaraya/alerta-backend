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
  if (limpio.startsWith('56')) {
    limpio = limpio.slice(2);
  }
  if (limpio.startsWith('9') && limpio.length === 9) {
    return limpio;
  }
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
  const alertaId = uuidv4(); // ID único para el emisor

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

      // 🧾 Alerta personalizada para el receptor
      const alertaParaContacto = {
        id: uuidv4(), // ID único por receptor
        senderName,
        senderPhone: senderLimpio,
        emisor: senderLimpio,
        destinatario: limpio,
        message,
        location,
        timestamp: new Date().toISOString(),
        estado: 'activa',
      };

      // 📥 Guardar alerta en alertas_recibidas del receptor
      await db
        .collection('usuarios')
        .doc(userDoc.id)
        .collection('alertas_recibidas')
        .doc(alertaParaContacto.id)
        .set(alertaParaContacto);

      // ➕ Agregar a lista de contactos registrados
      contactosRegistrados.push({
        id: userDoc.id,
        nombre: nombreContacto,
        telefono: limpio,
      });

      // 🚨 Enviar notificación push si el receptor tiene FCM token
      const fcmToken = userDoc.data().fcmToken;

      if (fcmToken && typeof fcmToken === 'string') {
        const messagePayload = {
          token: fcmToken,
          notification: {
            title: `🚨 Alerta de ${senderName}`,
            body: message || '¡Tienes una nueva alerta!',
          },
          data: {
            alertaId,
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
          const response = await admin.messaging().send(messagePayload);
          console.log(`✅ Notificación enviada a ${nombreContacto}:`, response);
        } catch (error) {
          console.error(`❌ Error enviando notificación a ${nombreContacto}:`, error.message);
        }
      }
    }
  }

  // 📤 Guardar alerta resumen en alertas_enviadas del emisor
  if (contactosRegistrados.length > 0) {
    const alertaParaEmisor = {
      id: alertaId,
      senderName,
      senderPhone: senderLimpio,
      emisor: senderLimpio,
      destinatarios: contactosRegistrados, // Lista de objetos {id, nombre, telefono}
      message,
      location,
      timestamp: new Date().toISOString(),
      estado: 'activa',
    };

    await db
      .collection('usuarios')
      .doc(emisorDoc.id)
      .collection('alertas_enviadas')
      .doc(alertaId)
      .set(alertaParaEmisor);
  }

  console.log('Contactos registrados que recibieron alerta:', contactosRegistrados);

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

// ✅ Ruta PUT para finalizar una alerta
app.put('/api/emergencias/finalizar/:id', async (req, res) => {
  const alertaId = req.params.id;

  try {
    const usuariosSnapshot = await db.collection('usuarios').get();
    let encontrada = false;

    for (const usuarioDoc of usuariosSnapshot.docs) {
      const userId = usuarioDoc.id;
      const usuarioRef = db.collection('usuarios').doc(userId);

      const [alertaEnviada, alertaRecibida] = await Promise.all([
        usuarioRef.collection('alertas_enviadas').doc(alertaId).get(),
        usuarioRef.collection('alertas_recibidas').doc(alertaId).get(),
      ]);

      if (alertaEnviada.exists) {
        await alertaEnviada.ref.update({ estado: 'finalizada' });
        encontrada = true;
      }

      if (alertaRecibida.exists) {
        await alertaRecibida.ref.update({ estado: 'finalizada' });
        encontrada = true;
      }
    }

    if (encontrada) {
      return res.json({ success: true, message: '✅ Alerta finalizada correctamente.' });
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

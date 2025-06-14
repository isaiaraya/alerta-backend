const admin = require('firebase-admin');

admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.PROJECT_ID,
    clientEmail: process.env.CLIENT_EMAIL,
    privateKey: process.env.PRIVATE_KEY.replace(/\\n/g, '\n'), // muy importante para que funcione
  }),
});

const db = admin.firestore();
module.exports = db;
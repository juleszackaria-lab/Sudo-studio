const admin = require('firebase-admin');
const serviceAccount = require('./sudo-studio-522bb-firebase-adminsdk-fbsvc-9d13a4a831.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

console.log('Firebase Admin SDK initialisé');

module.exports = admin;
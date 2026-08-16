/* global firebase */
importScripts('https://www.gstatic.com/firebasejs/12.17.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/12.17.1/firebase-messaging-compat.js');

try {
  const rawConfig = new URL(self.location.href).searchParams.get('config');
  if (rawConfig) {
    firebase.initializeApp(JSON.parse(rawConfig));
    firebase.messaging();
  }
} catch (error) {
  console.error('Firebase messaging service worker initialization failed', error);
}

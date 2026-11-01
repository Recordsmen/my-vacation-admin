/*
 * My Vacation admin — page config. Nothing here is secret: an OAuth client ID
 * is public by design, and data is fetched with the signed-in user's own token.
 * NEVER put keys, service accounts or tokens in this file (the Pages repo is public).
 */
window.MV_CONFIG = {
  // OAuth 2.0 Web client in Google Cloud project my-vacation-olik (Google Auth
  // Platform → Clients). Authorized JavaScript origin: https://recordsmen.github.io
  clientId: "",

  // GA4 property of the Firebase project (numeric id). Empty = find it at sign-in
  // through the Analytics Admin API (the property linked to firebaseProjectNumber).
  ga4PropertyId: "",
  firebaseProjectNumber: "318644605011",

  // BigQuery: Crashlytics export. Tables appear after the first event is exported.
  gcpProject: "my-vacation-olik",
  crashlyticsDataset: "firebase_crashlytics",
  crashlyticsTables: {
    android: "com_olikbobik_myvacation_ANDROID",
    ios: "com_olikbobik_myvacation_IOS",
  },

  // Firebase console deep links for Crashlytics issues.
  firebaseConsole: "https://console.firebase.google.com/project/my-vacation-olik/crashlytics/app",
  firebaseApps: {
    android: "android:com.olikbobik.myvacation",
    ios: "ios:com.olikbobik.myvacation",
  },

  scopes: [
    "email",
    "https://www.googleapis.com/auth/analytics.readonly",
    "https://www.googleapis.com/auth/bigquery.readonly",
  ],
};

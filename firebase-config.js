// ============================================================
// Firebase webova konfigurace pro Music Bingo
// ------------------------------------------------------------
// Poznamka: apiKey v klientskem kodu NENI secret. Je to verejny
// identifikator projektu. Skutecna ochrana dat je v Firestore
// Security Rules v konzoli Firebase.
// ============================================================

const firebaseConfig = {
  apiKey:            "AIzaSyDVOvjm5fShcyMt_UszpgCwt9IdEOxXR5I",
  authDomain:        "dnbingo-1eceb.firebaseapp.com",
  projectId:         "dnbingo-1eceb",
  storageBucket:     "dnbingo-1eceb.firebasestorage.app",
  messagingSenderId: "478151527754",
  appId:             "1:478151527754:web:51fcf7449aec50a30dc5b3"
};

firebase.initializeApp(firebaseConfig);

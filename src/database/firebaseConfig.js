import { initializeApp, getApps, getApp } from "firebase/app";
import { getDatabase } from "firebase/database";
import { getStorage } from "firebase/storage";

// Firebase Configuration for H.Rocker Material Manager
// This configuration supports both the Firebase JS SDK and custom REST requests.
const firebaseConfig = {
  apiKey: "AIzaSyA56axOQxYhJtD0bBlRktkk-v91_UIRpl0",
  authDomain: "material-list-hrocker-76b36.firebaseapp.com",
  databaseURL: "https://material-list-hrocker-76b36-default-rtdb.firebaseio.com",
  projectId: "material-list-hrocker-76b36",
  storageBucket: "material-list-hrocker-76b36.firebasestorage.app",
  messagingSenderId: "276466101873",
  appId: "1:276466101873:web:7d65af49fdf10ef13735d0",
};

export const FIREBASE_CONFIG = firebaseConfig;

const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();

export const database = getDatabase(app);
export const storage = getStorage(app);

export default app;

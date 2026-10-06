import { initializeApp } from 'firebase/app';
import {
    browserLocalPersistence, getAuth, indexedDBLocalPersistence, initializeAuth
} from 'firebase/auth';
import { getFirestore, enableIndexedDbPersistence, CACHE_SIZE_UNLIMITED } from 'firebase/firestore';
import { getStorage } from 'firebase/storage';

const firebaseConfig = {
    apiKey: process.env.REACT_APP_FIREBASE_API_KEY || 'AIzaSyAz5knhlAxZwUATy3mtW66Z6lHBrv4tUog',
    authDomain: process.env.REACT_APP_FIREBASE_AUTH_DOMAIN || 'toplink-edu.firebaseapp.com',
    projectId: process.env.REACT_APP_FIREBASE_PROJECT_ID || 'toplink-edu',
    storageBucket: process.env.REACT_APP_FIREBASE_STORAGE_BUCKET || 'toplink-edu.appspot.com',
    messagingSenderId: process.env.REACT_APP_FIREBASE_MESSAGING_SENDER_ID || '35786900143',
    appId: process.env.REACT_APP_FIREBASE_APP_ID || '1:35786900143:web:9e612336393d29324c0a5a',
    measurementId: process.env.REACT_APP_FIREBASE_MEASUREMENT_ID || 'G-3VSBS7R11D'
};


// Validate Firebase config
const validateConfig = () => {
    const required = ['apiKey', 'authDomain', 'projectId', 'storageBucket', 'messagingSenderId', 'appId'];
    const missing = required.filter(key => !firebaseConfig[key]);
    if (missing.length > 0) {
        console.error('Missing Firebase configuration:', missing);
        return false;
    }
    return true;
};

if (!validateConfig()) {
    console.error('Firebase configuration is incomplete. Check your environment variables.');
}

// Initialize Firebase
const app = initializeApp(firebaseConfig);
let auth;
try {
    auth = initializeAuth(app, {
        persistence: [indexedDBLocalPersistence, browserLocalPersistence]
    });
} catch (error) {
    if (error.code !== 'auth/already-initialized') throw error;
    auth = getAuth(app);
}
const db = getFirestore(app);
const activeDb = db;
const archiveDb = db;
const storage = getStorage(app);


// Enable offline persistence with error handling
if (typeof window !== 'undefined') {
    enableIndexedDbPersistence(db, {
        cacheSizeBytes: CACHE_SIZE_UNLIMITED
    })
    .then(() => {
        console.log('Firestore offline persistence enabled');
    })
    .catch((err) => {
        if (err.code === 'failed-precondition') {
            console.warn('Multiple tabs open, persistence can only be enabled in one tab at a time.');
        } else if (err.code === 'unimplemented') {
            console.warn('The current browser does not support offline persistence');
        } else {
            console.error('Failed to enable persistence:', err);
        }
    });
}

export { auth, db, activeDb, archiveDb, storage };
export default app;

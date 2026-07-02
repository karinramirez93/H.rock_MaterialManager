/**
 * AuthService
 * -----------
 * Firebase Authentication REST service plus local session management.
 *
 * This file intentionally uses Firebase Auth REST endpoints. That keeps the
 * Expo Go version of the app simple and avoids native Firebase Auth setup while
 * we are still testing the clean project.
 *
 * Features:
 * - Sign in with email OR username.
 * - Create account using the Name field as both display name and username.
 * - Continue as guest with viewer-only permissions.
 * - Keep the local app session active for six months.
 * - Store user profiles under /users/{uid}.
 * - Store username lookups under /usernames/{username}.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { FIREBASE_CONFIG } from './firebaseConfig';

const AUTH_SESSION_KEY = '@material_app_auth_session_v2';
const GUEST_DRAFT_KEY = '@material_draft_guest_temp_v1';
const FIREBASE_AUTH_BASE_URL = 'https://identitytoolkit.googleapis.com/v1/accounts';
const FIREBASE_TOKEN_REFRESH_URL = 'https://securetoken.googleapis.com/v1/token';
const SIX_MONTH_SESSION_MS = 1000 * 60 * 60 * 24 * 30 * 6;

const isFirebaseApiKeyConfigured = () => (
  Boolean(FIREBASE_CONFIG.apiKey)
);

const getWebApiKey = () => FIREBASE_CONFIG.apiKey;

const getAuthEndpoint = (action) => `${FIREBASE_AUTH_BASE_URL}:${action}?key=${getWebApiKey()}`;

const getDatabaseEndpoint = (path, idToken = '') => {
  const cleanPath = String(path || '').replace(/^\/+/, '');
  const authQuery = idToken ? `?auth=${idToken}` : '';
  return `${FIREBASE_CONFIG.databaseURL || FIREBASE_CONFIG.databaseUrl}/${cleanPath}.json${authQuery}`;
};

const normalizeUsername = (value) => {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '');
};

const looksLikeEmail = (value) => String(value || '').includes('@');

const createDefaultUsername = (displayName, email) => {
  const fromName = normalizeUsername(displayName);
  if (fromName) return fromName;
  return normalizeUsername(String(email || '').split('@')[0]);
};

const createSessionExpiration = () => String(Date.now() + SIX_MONTH_SESSION_MS);

const normalizeUserSession = (session) => ({
  uid: session?.uid || session?.localId || '',
  email: session?.email || '',
  username: normalizeUsername(session?.username || session?.userName || ''),
  displayName: session?.displayName || session?.name || session?.email || 'App User',
  role: session?.role || (session?.isGuest ? 'viewer' : 'editor'),
  isGuest: session?.isGuest === true,
  idToken: session?.idToken || '',
  refreshToken: session?.refreshToken || '',
  idTokenExpiresAt: session?.idTokenExpiresAt || '',
  sessionExpiresAt: session?.sessionExpiresAt || session?.expiresAt || createSessionExpiration(),
  createdAt: session?.createdAt || new Date().toISOString(),
  updatedAt: session?.updatedAt || new Date().toISOString()
});

const saveSession = async (session) => {
  const normalized = normalizeUserSession(session);
  await AsyncStorage.setItem(AUTH_SESSION_KEY, JSON.stringify(normalized));
  return normalized;
};

const isSessionExpired = (session) => {
  const expiration = Number(session?.sessionExpiresAt || 0);
  if (!expiration) return false;
  return Date.now() > expiration;
};

const requestFirebaseAuth = async (action, payload) => {
  if (!isFirebaseApiKeyConfigured()) {
    throw new Error('MISSING_FIREBASE_WEB_API_KEY');
  }

  const response = await fetch(getAuthEndpoint(action), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  const data = await response.json();

  if (!response.ok) {
    const errorCode = data?.error?.message || 'AUTH_REQUEST_FAILED';
    throw new Error(errorCode);
  }

  return data;
};


const requestFirebaseTokenRefresh = async (refreshToken) => {
  if (!refreshToken) {
    throw new Error('MISSING_REFRESH_TOKEN');
  }

  const response = await fetch(`${FIREBASE_TOKEN_REFRESH_URL}?key=${getWebApiKey()}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`
  });

  const data = await response.json();

  if (!response.ok) {
    const errorCode = data?.error?.message || 'TOKEN_REFRESH_FAILED';
    throw new Error(errorCode);
  }

  return data;
};

const loadUsernameRecord = async (username) => {
  const cleanUsername = normalizeUsername(username);
  if (!cleanUsername) return null;

  const response = await fetch(getDatabaseEndpoint(`usernames/${cleanUsername}`));
  if (!response.ok) {
    throw new Error('USERNAME_LOOKUP_FAILED');
  }

  return response.json();
};

// Used only while creating an account. If Firebase rules are not ready yet,
// account creation should not fail at the username lookup step. The actual
// profile/username save still happens after Firebase Auth creates the account.
const loadUsernameRecordSafely = async (username) => {
  try {
    return await loadUsernameRecord(username);
  } catch (error) {
    console.error('AuthService Warning (username pre-check):', error);
    return null;
  }
};

const resolveEmailFromIdentifier = async (identifier) => {
  const cleanIdentifier = String(identifier || '').trim();

  if (looksLikeEmail(cleanIdentifier)) {
    return cleanIdentifier;
  }

  const cleanUsername = normalizeUsername(cleanIdentifier);
  if (!cleanUsername) {
    throw new Error('USERNAME_NOT_FOUND');
  }

  const usernameRecord = await loadUsernameRecord(cleanUsername);

  if (!usernameRecord?.email) {
    throw new Error('USERNAME_NOT_FOUND');
  }

  return usernameRecord.email;
};

const saveUserProfile = async (profile, idToken) => {
  await fetch(getDatabaseEndpoint(`users/${profile.uid}`, idToken), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(profile)
  });
};

const saveUsernameRecord = async ({ username, uid, email, displayName }, idToken) => {
  const cleanUsername = normalizeUsername(username);
  if (!cleanUsername) return;

  await fetch(getDatabaseEndpoint(`usernames/${cleanUsername}`, idToken), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      uid,
      email,
      displayName,
      username: cleanUsername,
      updatedAt: new Date().toISOString()
    })
  });
};

export const AuthService = {
  isFirebaseApiKeyConfigured,
  normalizeUsername,

  async getCurrentUser() {
    try {
      const jsonValue = await AsyncStorage.getItem(AUTH_SESSION_KEY);
      if (!jsonValue) return null;

      const session = normalizeUserSession(JSON.parse(jsonValue));

      // Guest mode is intentionally temporary. If the app is closed and opened
      // again, the user must choose Guest again and the old guest draft is
      // cleared. Registered users keep their own account-specific drafts.
      if (session.isGuest) {
        await AsyncStorage.removeItem(AUTH_SESSION_KEY);
        await AsyncStorage.removeItem(GUEST_DRAFT_KEY);
        return null;
      }

      if (isSessionExpired(session)) {
        await AsyncStorage.removeItem(AUTH_SESSION_KEY);
        return null;
      }

      return session;
    } catch (error) {
      console.error('AuthService Error (getCurrentUser):', error);
      return null;
    }
  },

  async getCurrentUserDisplayName() {
    const user = await this.getCurrentUser();
    return user?.displayName || 'Shared App User';
  },

  async getCurrentUserRole() {
    const user = await this.getCurrentUser();
    return user?.role || 'viewer';
  },

  async isOwner() {
    const role = await this.getCurrentUserRole();
    return role === 'owner';
  },

  async canEditSharedData() {
    const user = await this.getCurrentUser();
    if (!user || user.isGuest) return false;
    return user.role === 'owner' || user.role === 'editor';
  },

  async ensureCanEditSharedData() {
    const canEdit = await this.canEditSharedData();
    if (!canEdit) {
      throw new Error('VIEWER_PERMISSION_DENIED');
    }
    return true;
  },

  async getCurrentIdToken() {
    const user = await this.getCurrentUser();
    if (!user || user.isGuest) return '';

    const expiresAt = Number(user.idTokenExpiresAt || 0);
    const hasFreshToken = user.idToken && expiresAt && Date.now() < (expiresAt - 1000 * 60 * 5);

    if (hasFreshToken) {
      return user.idToken;
    }

    if (!user.refreshToken) {
      return user.idToken || '';
    }

    try {
      const refreshed = await requestFirebaseTokenRefresh(user.refreshToken);
      const updatedSession = await saveSession({
        ...user,
        idToken: refreshed.id_token,
        refreshToken: refreshed.refresh_token || user.refreshToken,
        idTokenExpiresAt: String(Date.now() + Number(refreshed.expires_in || 3600) * 1000),
        updatedAt: new Date().toISOString()
      });
      return updatedSession.idToken || '';
    } catch (error) {
      console.error('AuthService Warning (token refresh):', error);
      return user.idToken || '';
    }
  },

  async signIn(identifier, password) {
    const resolvedEmail = await resolveEmailFromIdentifier(identifier);

    const authData = await requestFirebaseAuth('signInWithPassword', {
      email: resolvedEmail,
      password,
      returnSecureToken: true
    });

    let profile = null;
    try {
      const profileResponse = await fetch(getDatabaseEndpoint(`users/${authData.localId}`, authData.idToken));
      profile = await profileResponse.json();
    } catch (profileError) {
      console.error('AuthService Warning (profile load):', profileError);
    }

    const session = await saveSession({
      uid: authData.localId,
      email: authData.email,
      username: profile?.username || createDefaultUsername(profile?.displayName || authData.displayName, authData.email),
      displayName: profile?.displayName || authData.displayName || authData.email,
      role: profile?.role || 'editor',
      isGuest: false,
      idToken: authData.idToken,
      refreshToken: authData.refreshToken,
      idTokenExpiresAt: String(Date.now() + Number(authData.expiresIn || 3600) * 1000),
      sessionExpiresAt: createSessionExpiration(),
      createdAt: profile?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    return session;
  },

  async createAccount({ email, password, displayName, username, requestedRole = 'editor' }) {
    const cleanEmail = email.trim();
    const cleanDisplayName = displayName.trim() || cleanEmail;

    // The app now uses the Name field as both display name and username.
    // Example: Name = "Karin" creates username "karin".
    const cleanUsername = normalizeUsername(username || cleanDisplayName || createDefaultUsername(cleanDisplayName, cleanEmail));

    if (!cleanUsername) {
      throw new Error('INVALID_USERNAME');
    }

    const existingUsername = await loadUsernameRecordSafely(cleanUsername);
    if (existingUsername?.email) {
      throw new Error('USERNAME_EXISTS');
    }

    const authData = await requestFirebaseAuth('signUp', {
      email: cleanEmail,
      password,
      returnSecureToken: true
    });

    const now = new Date().toISOString();

    // Automatically assign "owner" role to the master account
    let finalRole = requestedRole || 'editor';
    const ownerEmail = 'karin_yova@hotmail.com';

    if (
      cleanUsername === 'karin' ||
      cleanDisplayName.toLowerCase() === 'karin' ||
      cleanEmail.toLowerCase() === ownerEmail.toLowerCase()
    ) {
      finalRole = 'owner';
    }

    const profile = {
      uid: authData.localId,
      email: authData.email,
      username: cleanUsername,
      displayName: cleanDisplayName,
      role: finalRole,
      disabled: false,
      createdAt: now,
      updatedAt: now
    };

    await saveUserProfile(profile, authData.idToken);
    await saveUsernameRecord(profile, authData.idToken);

    return saveSession({
      ...profile,
      isGuest: false,
      idToken: authData.idToken,
      refreshToken: authData.refreshToken,
      idTokenExpiresAt: String(Date.now() + Number(authData.expiresIn || 3600) * 1000),
      sessionExpiresAt: createSessionExpiration()
    });
  },

  async continueAsGuest() {
    return saveSession({
      uid: `guest-${Date.now()}`,
      email: '',
      username: 'guest',
      displayName: 'Guest User',
      role: 'viewer',
      isGuest: true,
      idToken: '',
      refreshToken: '',
      sessionExpiresAt: createSessionExpiration(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
  },

  async updateLocalDisplayName(displayName) {
    const currentUser = await this.getCurrentUser();
    if (!currentUser) return null;

    const updatedUser = await saveSession({
      ...currentUser,
      displayName: displayName.trim() || currentUser.displayName,
      updatedAt: new Date().toISOString()
    });

    return updatedUser;
  },

  async signOut() {
    const currentUser = await this.getCurrentUser();
    await AsyncStorage.removeItem(AUTH_SESSION_KEY);
    if (currentUser?.isGuest) {
      await AsyncStorage.removeItem(GUEST_DRAFT_KEY);
    }
  }
};

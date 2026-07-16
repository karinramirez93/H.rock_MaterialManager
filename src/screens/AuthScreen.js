/**
 * AuthScreen
 * ----------
 * Login and account creation screen for the material app.
 *
 * Users can:
 * - Sign in with email or username.
 * - Create an account with one Name field. That name also becomes the username.
 * - Continue as Guest with viewer-only permissions.
 *
 * Guest users can view the catalog, create a temporary Material Requirements,
 * and share it, but they cannot edit shared Firebase catalog data.
 */
import React, { useState } from 'react';
import { ActivityIndicator, Alert, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { AuthService } from '../database/authService';

export default function AuthScreen({ onAuthenticated }) {
  const [isCreateMode, setIsCreateMode] = useState(false);
  const [displayName, setDisplayName] = useState('');
  const [identifier, setIdentifier] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);

  const getFriendlyAuthError = (errorMessage) => {
    switch (errorMessage) {
      case 'MISSING_FIREBASE_WEB_API_KEY':
        return 'Firebase Web API Key is missing. Add it in src/database/firebaseConfig.js before using login.';
      case 'EMAIL_EXISTS':
        return 'This email already has an account. Try signing in instead.';
      case 'USERNAME_EXISTS':
        return 'This name/username is already taken. Please choose another name or add a number.';
      case 'USERNAME_NOT_FOUND':
        return 'Username was not found. Try your email address or create an account first.';
      case 'USERNAME_LOOKUP_FAILED':
        return 'The app could not read username records. Check Firebase Realtime Database rules for /usernames.';
      case 'INVALID_USERNAME':
        return 'Please enter a valid name. The app will convert it into a username using letters, numbers, underscores, or hyphens.';
      case 'EMAIL_NOT_FOUND':
      case 'INVALID_LOGIN_CREDENTIALS':
      case 'INVALID_PASSWORD':
        return 'Email/username or password is incorrect.';
      case 'WEAK_PASSWORD : Password should be at least 6 characters':
        return 'Password should be at least 6 characters.';
      case 'VIEWER_PERMISSION_DENIED':
        return 'This account only has viewer access.';
      default:
        return errorMessage || 'Could not complete authentication.';
    }
  };

  const handleSubmit = async () => {
    const loginIdentifier = identifier.trim();
    const cleanEmail = email.trim();
    const cleanDisplayName = displayName.trim();

    if (isCreateMode) {
      if (!cleanDisplayName || !cleanEmail || !password.trim()) {
        Alert.alert('Required Fields', 'Please enter your name, email, and password. Your name will also be used as your username.');
        return;
      }
    } else if (!loginIdentifier || !password.trim()) {
      Alert.alert('Required Fields', 'Please enter your email/username and password.');
      return;
    }

    try {
      setLoading(true);
      const user = isCreateMode
        ? await AuthService.createAccount({
            email: cleanEmail,
            password,
            displayName: cleanDisplayName,
            username: cleanDisplayName,
            requestedRole: 'editor'
          })
        : await AuthService.signIn(loginIdentifier, password);
      onAuthenticated(user);
    } catch (error) {
      console.error('Authentication error:', error);
      Alert.alert('Authentication Error', getFriendlyAuthError(error.message));
    } finally {
      setLoading(false);
    }
  };

  const handleGuestAccess = async () => {
    try {
      setLoading(true);
      const user = await AuthService.continueAsGuest();
      onAuthenticated(user);
    } catch (error) {
      console.error('Guest access error:', error);
      Alert.alert('Guest Access Error', 'Could not continue as guest.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={['top', 'left', 'right', 'bottom']}>
      <StatusBar style="light" />
      <View style={styles.authHeader}>
        {isCreateMode ? (
          <TouchableOpacity style={styles.authBackButton} onPress={() => setIsCreateMode(false)} disabled={loading}>
            <Text style={styles.authBackText}>‹</Text>
          </TouchableOpacity>
        ) : (
          <View style={styles.authHeaderSpacer} />
        )}
        <Text style={styles.authHeaderTitle}>{isCreateMode ? 'Create Account' : 'Material App Login'}</Text>
        <View style={styles.authHeaderSpacer} />
      </View>

      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.subtitle}>
          {isCreateMode
            ? 'Create your teammate account. Your name will also become your username.'
            : 'Sign in so the app can track who creates lists and who updates shared catalog data.'}
        </Text>

        {isCreateMode ? (
          <View>
            <Text style={styles.label}>Name:</Text>
            <TextInput
              style={styles.input}
              value={displayName}
              onChangeText={setDisplayName}
              placeholder="e.g.: Maria"
              placeholderTextColor="#99a"
            />
            <Text style={styles.helperText}>This name will be shown as Created By.</Text>

            <Text style={styles.label}>Email:</Text>
            <TextInput style={styles.input} value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" placeholder="name@example.com" placeholderTextColor="#99a" />
          </View>
        ) : (
          <View>
            <Text style={styles.label}>Email or Username:</Text>
            <TextInput style={styles.input} value={identifier} onChangeText={setIdentifier} autoCapitalize="none" keyboardType="email-address" placeholder="email@example.com or username" placeholderTextColor="#99a" />
          </View>
        )}

        <Text style={styles.label}>Password:</Text>
        <View style={styles.passwordContainer}>
          <TextInput
            style={styles.passwordInput}
            value={password}
            onChangeText={setPassword}
            secureTextEntry={!showPassword}
            placeholder="Minimum 6 characters"
            placeholderTextColor="#99a"
          />
          <TouchableOpacity
            style={styles.eyeButton}
            onPress={() => setShowPassword(!showPassword)}
          >
            <Text style={styles.eyeIcon}>{showPassword ? '👁️' : '👁️‍🗨️'}</Text>
          </TouchableOpacity>
        </View>

        <TouchableOpacity style={styles.primaryButton} onPress={handleSubmit} disabled={loading}>
          {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryButtonText}>{isCreateMode ? 'CREATE ACCOUNT' : 'SIGN IN'}</Text>}
        </TouchableOpacity>

        <TouchableOpacity style={styles.switchButton} onPress={() => setIsCreateMode((current) => !current)}>
          <Text style={styles.switchText}>{isCreateMode ? 'I already have an account' : 'Create a new teammate account'}</Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.guestButton} onPress={handleGuestAccess} disabled={loading}>
          <Text style={styles.guestButtonText}>Continue as Guest</Text>
        </TouchableOpacity>

        <View style={styles.noteCard}>
          <Text style={styles.noteTitle}>Role Note</Text>
          <Text style={styles.noteText}>New accounts start as Editor. Guest users can view the catalog and create lists, but they cannot modify shared catalog data.</Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a192f' },
  authHeader: { height: 58, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, borderBottomWidth: 1, borderBottomColor: '#233554', backgroundColor: '#112240' },
  authBackButton: { width: 42, height: 42, alignItems: 'center', justifyContent: 'center' },
  authBackText: { color: '#64ffda', fontSize: 36, lineHeight: 38, fontWeight: '300' },
  authHeaderSpacer: { width: 42, height: 42 },
  authHeaderTitle: { flex: 1, color: '#64ffda', fontSize: 20, fontWeight: '900', textAlign: 'center' },
  content: { padding: 20, justifyContent: 'center', flexGrow: 1 },
  subtitle: { color: '#8892b0', fontSize: 14, textAlign: 'center', marginBottom: 25, lineHeight: 20 },
  label: { color: '#e6f1ff', fontWeight: 'bold', marginBottom: 6, fontSize: 13, textTransform: 'uppercase' },
  helperText: { color: '#8892b0', fontSize: 12, marginTop: -8, marginBottom: 14, lineHeight: 17 },
  input: { backgroundColor: '#172a45', padding: 13, borderRadius: 10, borderWidth: 1, borderColor: '#303c55', color: '#e6f1ff', fontSize: 15, marginBottom: 15 },
  passwordContainer: {
    flexDirection: 'row',
    backgroundColor: '#172a45',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#303c55',
    alignItems: 'center',
    marginBottom: 15
  },
  passwordInput: {
    flex: 1,
    padding: 13,
    color: '#e6f1ff',
    fontSize: 15
  },
  eyeButton: {
    padding: 10,
    marginRight: 5
  },
  eyeIcon: {
    fontSize: 20
  },
  primaryButton: { backgroundColor: '#0275d8', padding: 15, borderRadius: 10, alignItems: 'center', borderWidth: 1, borderColor: '#00d2ff', marginTop: 8 },
  primaryButtonText: { color: '#fff', fontWeight: 'bold', fontSize: 15 },
  switchButton: { alignItems: 'center', marginTop: 18 },
  switchText: { color: '#64ffda', fontWeight: 'bold' },
  guestButton: { alignItems: 'center', marginTop: 18, padding: 12, borderRadius: 10, borderWidth: 1, borderColor: '#64ffda' },
  guestButtonText: { color: '#64ffda', fontWeight: 'bold' },
  noteCard: { backgroundColor: '#112240', padding: 14, borderRadius: 10, borderWidth: 1, borderColor: '#233554', marginTop: 25 },
  noteTitle: { color: '#64ffda', fontWeight: 'bold', marginBottom: 5 },
  noteText: { color: '#ccd6f6', lineHeight: 19 }
});

/**
 * ProfileScreen
 * -------------
 * Simple account screen. It lets the current user confirm the display name
 * that will be used for Created By and audit fields.
 */
import React, { useEffect, useState } from 'react';
import { Alert, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AuthService } from '../database/authService';

export default function ProfileScreen({ onSignOut }) {
  const [user, setUser] = useState(null);
  const [displayName, setDisplayName] = useState('');

  useEffect(() => {
    const load = async () => {
      const currentUser = await AuthService.getCurrentUser();
      setUser(currentUser);
      setDisplayName(currentUser?.displayName || '');
    };
    load();
  }, []);

  const saveDisplayName = async () => {
    const updated = await AuthService.updateLocalDisplayName(displayName);
    setUser(updated);
    Alert.alert('Saved', 'Your local display name was updated.');
  };

  const handleSignOut = async () => {
    Alert.alert('Sign Out', 'Do you want to sign out of this device?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign Out', style: 'destructive', onPress: async () => { await AuthService.signOut(); onSignOut(); } }
    ]);
  };

  return (
    <SafeAreaView style={styles.container} edges={['left', 'right', 'bottom']}>
      <View style={styles.content}>
        <Text style={styles.title}>USER PROFILE</Text>

        {user?.isGuest ? (
          <View style={styles.guestCard}>
            <Text style={styles.guestTitle}>Guest Mode</Text>
            <Text style={styles.guestText}>You can view the catalog, create a Material Quantity Sheet, and send it. Shared catalog editing is disabled.</Text>
          </View>
        ) : null}

        <Text style={styles.infoLabel}>Email</Text>
        <Text style={styles.infoValue}>{user?.email || 'Guest session'}</Text>

        <Text style={styles.infoLabel}>Username</Text>
        <Text style={styles.infoValue}>{user?.username || 'Not set'}</Text>

        <Text style={styles.infoLabel}>Role</Text>
        <Text style={styles.roleBadge}>{(user?.role || 'viewer').toUpperCase()}</Text>

        <Text style={styles.label}>Display Name / Created By:</Text>
        <TextInput
          style={styles.input}
          value={displayName}
          onChangeText={setDisplayName}
          placeholder="Your name"
          placeholderTextColor="#99a"
          editable={!user?.isGuest}
        />

        {!user?.isGuest ? (
          <TouchableOpacity style={styles.saveButton} onPress={saveDisplayName}>
            <Text style={styles.buttonText}>SAVE DISPLAY NAME</Text>
          </TouchableOpacity>
        ) : null}

        <TouchableOpacity style={styles.signOutButton} onPress={handleSignOut}>
          <Text style={styles.buttonText}>{user?.isGuest ? 'EXIT GUEST MODE' : 'SIGN OUT'}</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a192f' },
  content: { padding: 20 },
  title: { color: '#64ffda', fontSize: 18, fontWeight: '900', textAlign: 'center', marginBottom: 20 },
  guestCard: { backgroundColor: '#112240', padding: 14, borderRadius: 10, borderWidth: 1, borderColor: '#64ffda', marginBottom: 15 },
  guestTitle: { color: '#64ffda', fontWeight: 'bold', marginBottom: 6 },
  guestText: { color: '#ccd6f6', lineHeight: 19 },
  infoLabel: { color: '#8892b0', fontWeight: 'bold', fontSize: 12, textTransform: 'uppercase', marginTop: 10 },
  infoValue: { color: '#e6f1ff', fontSize: 15, marginTop: 4 },
  roleBadge: { alignSelf: 'flex-start', backgroundColor: '#112240', color: '#64ffda', fontWeight: '900', paddingVertical: 7, paddingHorizontal: 12, borderRadius: 999, borderWidth: 1, borderColor: '#64ffda', marginTop: 6 },
  label: { color: '#e6f1ff', fontWeight: 'bold', marginBottom: 6, fontSize: 13, textTransform: 'uppercase', marginTop: 22 },
  input: { backgroundColor: '#172a45', padding: 13, borderRadius: 10, borderWidth: 1, borderColor: '#303c55', color: '#e6f1ff', fontSize: 15, marginBottom: 15 },
  saveButton: { backgroundColor: '#0275d8', padding: 15, borderRadius: 10, alignItems: 'center', marginTop: 8 },
  signOutButton: { backgroundColor: '#ff4d4d', padding: 15, borderRadius: 10, alignItems: 'center', marginTop: 14 },
  buttonText: { color: '#fff', fontWeight: 'bold' }
});

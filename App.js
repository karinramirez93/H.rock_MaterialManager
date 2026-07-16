import 'react-native-gesture-handler';
import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, BackHandler, StyleSheet, View, Text, TouchableOpacity } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

// Local screen imports. Each screen keeps one specific responsibility so the app stays easy to maintain.
import DraftScreen from './src/screens/DraftScreen';
import CatalogScreen from './src/screens/CatalogScreen';
import AddMaterialScreen from './src/screens/AddMaterialScreen';
import CatalogManagerScreen from './src/screens/CatalogManagerScreen';
import ImportantInfoScreen from './src/screens/ImportantInfoScreen';
import AuthScreen from './src/screens/AuthScreen';
import ProfileScreen from './src/screens/ProfileScreen';
import CableRequirementsScreen from './src/screens/CableRequirementsScreen';
import HomeHeaderButton from './src/components/HomeHeaderButton';
import { AuthService } from './src/database/authService';

const Stack = createNativeStackNavigator();

/**
 * App
 * ---
 * Root component of the project. It configures authentication, navigation,
 * safe-area support, and shared header style for the whole application.
 *
 * Authentication is loaded before the main navigation stack. Once the user is
 * signed in, their display name is used in DraftScreen as the automatic
 * Created By value and in StorageService audit fields.
 */
export default function App() {
  const navigationRef = useRef(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [currentUser, setCurrentUser] = useState(null);



  /**
   * Global Android back behavior.
   * Screen-level handlers still run first when a modal or editor is open.
   * If no screen consumes the event, this handler moves back in the stack.
   * On the home Material Requisition screen, it asks before closing the app.
   */
  useEffect(() => {
    if (!currentUser) return undefined;

    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      const navigation = navigationRef.current;

      if (navigation?.canGoBack()) {
        navigation.goBack();
        return true;
      }

      Alert.alert('Exit App', 'Do you want to close Material Manager?', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Exit', style: 'destructive', onPress: () => BackHandler.exitApp() }
      ]);
      return true;
    });

    return () => subscription.remove();
  }, [currentUser]);

  useEffect(() => {
    const loadCurrentUser = async () => {
      const user = await AuthService.getCurrentUser();
      setCurrentUser(user);
      setAuthLoading(false);
    };

    loadCurrentUser();
  }, []);

  if (authLoading) {
    return (
      <GestureHandlerRootView style={styles.container}>
        <SafeAreaProvider>
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color="#64ffda" />
          </View>
        </SafeAreaProvider>
      </GestureHandlerRootView>
    );
  }

  if (!currentUser) {
    return (
      <GestureHandlerRootView style={styles.container}>
        <SafeAreaProvider>
          <AuthScreen onAuthenticated={setCurrentUser} />
        </SafeAreaProvider>
      </GestureHandlerRootView>
    );
  }

  return (
    <GestureHandlerRootView style={styles.container}>
      <SafeAreaProvider>
        <NavigationContainer ref={navigationRef}>
          <Stack.Navigator
            initialRouteName="Draft"
            screenOptions={({ navigation, route }) => ({
              headerStyle: {
                backgroundColor: '#112240',
                elevation: 0,
                shadowOpacity: 0,
                borderBottomWidth: 1,
                borderBottomColor: '#233554'
              },
              headerTintColor: '#64ffda',
              headerTitleStyle: { fontWeight: 'bold', fontSize: 18 },
              headerTitleAlign: 'center',
              contentStyle: { backgroundColor: '#0a192f' },
              gestureEnabled: true,
              headerRight: () => {
                if (route.name === 'Draft') return null;
                if (route.name === 'AddMaterial') {
                  return (
                    <TouchableOpacity
                      style={styles.closeHeaderButton}
                      onPress={() => navigation.goBack()}
                    >
                      <Text style={styles.closeHeaderIcon}>✕</Text>
                    </TouchableOpacity>
                  );
                }
                return <HomeHeaderButton navigation={navigation} />;
              }
            })}
          >
            <Stack.Screen name="Draft" options={{ headerShown: false }}>
              {(props) => <DraftScreen {...props} currentUser={currentUser} />}
            </Stack.Screen>
            <Stack.Screen name="Catalog" options={{ title: 'Search Catalog' }}>
              {(props) => <CatalogScreen {...props} currentUser={currentUser} />}
            </Stack.Screen>
            <Stack.Screen name="CatalogManager" options={{ title: 'Manage Catalog' }}>
              {(props) => <CatalogManagerScreen {...props} currentUser={currentUser} />}
            </Stack.Screen>
            <Stack.Screen name="AddMaterial" options={{ title: 'Add New Material' }}>
              {(props) => <AddMaterialScreen {...props} currentUser={currentUser} />}
            </Stack.Screen>
            <Stack.Screen name="ImportantInfo" options={{ title: 'Important Info' }}>
              {(props) => <ImportantInfoScreen {...props} currentUser={currentUser} />}
            </Stack.Screen>
            <Stack.Screen name="CableRequirements" options={{ title: 'Cable & Wire Requirements' }}>
              {(props) => <CableRequirementsScreen {...props} currentUser={currentUser} />}
            </Stack.Screen>
            <Stack.Screen name="Profile" options={{ title: 'User Profile' }}>
              {(props) => <ProfileScreen {...props} onSignOut={() => setCurrentUser(null)} />}
            </Stack.Screen>
          </Stack.Navigator>
        </NavigationContainer>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  loadingContainer: { flex: 1, backgroundColor: '#0a192f', justifyContent: 'center', alignItems: 'center' },
  closeHeaderButton: {
    width: 38,
    height: 38,
    marginRight: 10,
    borderRadius: 19,
    backgroundColor: '#172a45',
    borderWidth: 1,
    borderColor: '#ff4d4d',
    justifyContent: 'center',
    alignItems: 'center',
  },
  closeHeaderIcon: {
    color: '#ff4d4d',
    fontSize: 18,
    fontWeight: 'bold',
  },
});

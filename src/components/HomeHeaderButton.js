import React from 'react';
import { StyleSheet, Text, TouchableOpacity } from 'react-native';

/**
 * HomeHeaderButton
 * ----------------
 * This small reusable component is shown in the navigation header on every
 * secondary screen. Its only responsibility is to take the user directly back
 * to the main Material Requisition screen without forcing them to press the
 * default back button multiple times.
 *
 * We use navigation.reset instead of navigation.navigate because reset clears
 * the navigation stack and makes Draft the new root screen. This gives the user
 * a clean return to the main screen from any nested screen.
 */
export default function HomeHeaderButton({ navigation }) {
  const goToMainScreen = () => {
    navigation.reset({
      index: 0,
      routes: [{ name: 'Draft' }],
    });
  };

  return (
    <TouchableOpacity
      style={styles.button}
      onPress={goToMainScreen}
      accessibilityRole="button"
      accessibilityLabel="Go to the main screen"
    >
      <Text style={styles.icon}>⌂</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  button: {
    width: 38,
    height: 38,
    marginRight: 10,
    borderRadius: 19,
    backgroundColor: '#172a45',
    borderWidth: 1,
    borderColor: '#64ffda',
    justifyContent: 'center',
    alignItems: 'center',
  },
  icon: {
    color: '#64ffda',
    fontSize: 22,
    fontWeight: 'bold',
    marginTop: -2,
  },
});

/**
 * ScreenContainer
 * ---------------
 * Shared screen wrapper used by new screens and future refactors.
 * It solves three common mobile layout problems:
 * 1. Safe area protection for notches, status bars, and Android navigation buttons.
 * 2. Keyboard protection for forms so TextInput fields are not hidden.
 * 3. Consistent background color and optional padding across the app.
 *
 * Existing screens may still use SafeAreaView directly. New screens should use this
 * wrapper so Android and iOS behave consistently.
 */
import React from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  TouchableWithoutFeedback,
  Keyboard,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { COLORS } from '../theme/theme';

export default function ScreenContainer({
  children,
  style,
  contentStyle,
  edges = ['top', 'left', 'right', 'bottom'],
  keyboardAware = false,
  dismissKeyboard = false,
}) {
  const content = (
    <View style={[styles.content, contentStyle]}>
      {children}
    </View>
  );

  const keyboardContent = keyboardAware ? (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 12 : 0}
    >
      {dismissKeyboard ? (
        <TouchableWithoutFeedback onPress={Keyboard.dismiss} accessible={false}>
          {content}
        </TouchableWithoutFeedback>
      ) : content}
    </KeyboardAvoidingView>
  ) : content;

  return (
    <SafeAreaView style={[styles.container, style]} edges={edges}>
      {keyboardContent}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  content: {
    flex: 1,
  },
});

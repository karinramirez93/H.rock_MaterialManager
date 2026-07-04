/**
 * useAndroidBackHandler
 * ---------------------
 * Small reusable hook for Android hardware back button handling.
 * Return true from the callback when the screen handled the back press.
 * Return false to let React Navigation or the global App handler handle it.
 */
import { useEffect } from 'react';
import { BackHandler, Platform } from 'react-native';

export default function useAndroidBackHandler(onBackPress, enabled = true) {
  useEffect(() => {
    if (Platform.OS !== 'android' || !enabled) return undefined;

    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (typeof onBackPress === 'function') {
        return !!onBackPress();
      }
      return false;
    });

    return () => subscription.remove();
  }, [onBackPress, enabled]);
}

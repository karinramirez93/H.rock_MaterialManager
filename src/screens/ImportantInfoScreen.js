/**
 * ImportantInfoScreen
 * -------------------
 * Shared reference library for field information that does not belong inside
 * the material catalog or the active requisition. Examples include conduit fill
 * reference photos, ground wire tables, amperage notes, or any job-site guide
 * that the whole team may need to check repeatedly.
 *
 * Each card has:
 * - title: the label shown before opening or editing the item.
 * - body: optional text notes or explanation.
 * - imageUri: optional high-quality photo/screenshot saved to Firebase as a data URI.
 *
 * This version keeps the normal view clean:
 * - Edit and delete actions are hidden until the gear/edit mode is enabled.
 * - The list can be shown with large thumbnails or as title-only rows.
 * - Saved images open full screen and use touch pinch gestures for zooming.
 *
 * Important Info uses a different image policy than the material catalog:
 * catalog photos are small thumbnails, but reference screenshots/tables need to
 * remain readable. For that reason, this screen keeps higher image quality and
 * displays images with resizeMode='contain' so the full picture is visible.
 */
import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Dimensions,
  FlatList,
  Image,
  Modal,
  PanResponder,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  BackHandler
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import { StorageService } from '../database/storage';

// Important Info images are intentionally kept larger and cleaner than catalog thumbnails.
// These pictures may contain tables, wire charts, conduit-fill screenshots, or other
// reference information where small text must stay readable.
const IMPORTANT_INFO_IMAGE_MAX_WIDTH = 1800;
const IMPORTANT_INFO_IMAGE_COMPRESSION = 0.92;
const VIEWER_WIDTH = Dimensions.get('window').width;
const VIEWER_HEIGHT = Dimensions.get('window').height;

// These constants control the pinch-to-zoom behavior in the full-screen viewer.
// The scale is intentionally limited so the image stays usable and does not become
// too large for the phone to render smoothly.
const MIN_IMAGE_SCALE = 1;
const MAX_IMAGE_SCALE = 5;

const getTouchDistance = (touches) => {
  if (!touches || touches.length < 2) return 0;
  const firstTouch = touches[0];
  const secondTouch = touches[1];
  const deltaX = firstTouch.pageX - secondTouch.pageX;
  const deltaY = firstTouch.pageY - secondTouch.pageY;
  return Math.sqrt(deltaX * deltaX + deltaY * deltaY);
};

const clampScale = (scale) => Math.min(MAX_IMAGE_SCALE, Math.max(MIN_IMAGE_SCALE, scale));

export default function ImportantInfoScreen({ navigation, currentUser }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const canEditSharedData = currentUser?.role === 'owner' || currentUser?.role === 'editor';
  const [modalVisible, setModalVisible] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editingItem, setEditingItem] = useState(null);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [imageUri, setImageUri] = useState('');

  // Edit mode keeps the normal Important Info library clean. Edit and delete
  // buttons appear only after the user taps the gear button, similar to the
  // catalog manager behavior already used elsewhere in the app.
  const [isEditMode, setIsEditMode] = useState(false);

  // The user can switch the list between a visual thumbnail layout and a compact
  // title-only layout. Thumbnail view is useful for image recognition, while
  // title-only view is faster when the library becomes large.
  const [viewMode, setViewMode] = useState('thumbnail');

  // Full-screen image viewer state.
  // Important Info can contain reference tables and screenshots with small text,
  // so tapping a card opens the image in a dedicated viewer.
  const [viewerVisible, setViewerVisible] = useState(false);
  const [viewerItem, setViewerItem] = useState(null);
  const [imageScale, setImageScale] = useState(1);
  const [imageTranslate, setImageTranslate] = useState({ x: 0, y: 0 });

  // Gesture refs keep the full-screen viewer independent from Reanimated.
  // This is intentional because this version is based on the last stable app
  // build. The viewer uses React Native PanResponder only, so it does not need
  // babel.config.js changes or a native rebuild just to detect pinch gestures.
  const imageScaleRef = useRef(1);
  const imageTranslateRef = useRef({ x: 0, y: 0 });
  const pinchStartDistanceRef = useRef(0);
  const pinchStartScaleRef = useRef(1);
  const panStartTouchRef = useRef({ x: 0, y: 0 });
  const panStartTranslateRef = useRef({ x: 0, y: 0 });
  const lastTapTimeRef = useRef(0);
  const touchMovedRef = useRef(false);

  const updateImageScale = (nextScale) => {
    const clampedScale = clampScale(nextScale);
    imageScaleRef.current = clampedScale;
    setImageScale(clampedScale);

    // When the image returns to normal size, the position also returns to center.
    if (clampedScale <= 1) {
      imageTranslateRef.current = { x: 0, y: 0 };
      setImageTranslate({ x: 0, y: 0 });
    }
  };

  const updateImageTranslate = (nextTranslate) => {
    imageTranslateRef.current = nextTranslate;
    setImageTranslate(nextTranslate);
  };

  const pinchResponder = useMemo(() => PanResponder.create({
    // The full-screen image area should own the touch interaction so two-finger
    // gestures are not stolen by parent ScrollViews or buttons.
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onStartShouldSetPanResponderCapture: () => true,
    onMoveShouldSetPanResponderCapture: () => true,

    onPanResponderGrant: (event) => {
      const touches = event.nativeEvent.touches || [];
      touchMovedRef.current = false;

      if (touches.length >= 2) {
        pinchStartDistanceRef.current = getTouchDistance(touches);
        pinchStartScaleRef.current = imageScaleRef.current;
        return;
      }

      const firstTouch = touches[0];
      if (firstTouch) {
        panStartTouchRef.current = { x: firstTouch.pageX, y: firstTouch.pageY };
        panStartTranslateRef.current = imageTranslateRef.current;
      }
    },

    onPanResponderMove: (event) => {
      const touches = event.nativeEvent.touches || [];

      // Pinch zoom: two fingers moving farther apart increases the image scale.
      // Moving them closer together decreases it.
      if (touches.length >= 2) {
        const currentDistance = getTouchDistance(touches);
        const startingDistance = pinchStartDistanceRef.current;

        if (startingDistance <= 0 || currentDistance <= 0) return;

        touchMovedRef.current = true;
        const gestureScale = currentDistance / startingDistance;
        updateImageScale(pinchStartScaleRef.current * gestureScale);
        return;
      }

      // Drag/pan: one finger can move the image only after it is zoomed in.
      if (touches.length === 1 && imageScaleRef.current > 1) {
        const firstTouch = touches[0];
        const deltaX = firstTouch.pageX - panStartTouchRef.current.x;
        const deltaY = firstTouch.pageY - panStartTouchRef.current.y;

        if (Math.abs(deltaX) > 3 || Math.abs(deltaY) > 3) {
          touchMovedRef.current = true;
        }

        updateImageTranslate({
          x: panStartTranslateRef.current.x + deltaX,
          y: panStartTranslateRef.current.y + deltaY
        });
      }
    },

    onPanResponderRelease: () => {
      pinchStartDistanceRef.current = 0;
      pinchStartScaleRef.current = imageScaleRef.current;

      // Double tap toggles between normal size and a readable zoom level.
      // This is a helper gesture; pinch remains the main zoom behavior.
      const currentTime = Date.now();
      const timeSinceLastTap = currentTime - lastTapTimeRef.current;

      if (!touchMovedRef.current && timeSinceLastTap < 280) {
        const nextScale = imageScaleRef.current > 1 ? 1 : 2.4;
        updateImageScale(nextScale);
      }

      lastTapTimeRef.current = currentTime;
      touchMovedRef.current = false;
    },

    onPanResponderTerminate: () => {
      pinchStartDistanceRef.current = 0;
      pinchStartScaleRef.current = imageScaleRef.current;
      touchMovedRef.current = false;
    }
  }), []);

  const sortedItems = useMemo(() => {
    return [...items].sort((a, b) => (a.title || '').localeCompare(b.title || ''));
  }, [items]);

  const loadInfo = async () => {
    try {
      setLoading(true);
      const data = await StorageService.loadImportantInfo();
      setItems(data);
    } catch (error) {
      console.error('Important info load error:', error);
      Alert.alert('Error', 'Could not load important information.');
    } finally {
      setLoading(false);
    }
  };

  useFocusEffect(useCallback(() => { loadInfo(); }, []));

  const openNewModal = () => {
    setEditingItem(null);
    setTitle('');
    setBody('');
    setImageUri('');
    setModalVisible(true);
  };

  const openEditModal = (item) => {
    setEditingItem(item);
    setTitle(item.title || '');
    setBody(item.body || '');
    setImageUri(item.imageUri || '');
    setModalVisible(true);
  };

  const openImageViewer = (item) => {
    if (!item?.imageUri) return;
    setViewerItem(item);
    updateImageScale(1);
    updateImageTranslate({ x: 0, y: 0 });
    setViewerVisible(true);
  };

  const closeImageViewer = () => {
    setViewerVisible(false);
    setViewerItem(null);
    updateImageScale(1);
    updateImageTranslate({ x: 0, y: 0 });
    pinchStartDistanceRef.current = 0;
    pinchStartScaleRef.current = 1;
  };


  // Handles the Android system Back button in the Important Info library.
  // The image viewer closes first, then the add/edit modal, then edit mode.
  // Only after those temporary states are closed does Back return to the
  // previous screen.
  useFocusEffect(useCallback(() => {
    const handleDeviceBack = () => {
      if (viewerVisible) {
        closeImageViewer();
        return true;
      }

      if (modalVisible) {
        setModalVisible(false);
        return true;
      }

      if (isEditMode) {
        setIsEditMode(false);
        return true;
      }

      if (navigation.canGoBack()) {
        navigation.goBack();
        return true;
      }

      return false;
    };

    const subscription = BackHandler.addEventListener('hardwareBackPress', handleDeviceBack);
    return () => subscription.remove();
  }, [navigation, viewerVisible, modalVisible, isEditMode]));

  // A double tap quickly resets the image size. The main zoom action is still
  // pinch-to-zoom, but reset is useful after inspecting a small table.
  const resetImageScale = () => {
    updateImageScale(1);
    updateImageTranslate({ x: 0, y: 0 });
  };

  const prepareHighQualityInfoImage = async (uri) => {
    const processedImage = await ImageManipulator.manipulateAsync(
      uri,
      [{ resize: { width: IMPORTANT_INFO_IMAGE_MAX_WIDTH } }],
      {
        compress: IMPORTANT_INFO_IMAGE_COMPRESSION,
        format: ImageManipulator.SaveFormat.JPEG,
        base64: true
      }
    );

    return `data:image/jpeg;base64,${processedImage.base64}`;
  };

  const pickImageFromLibrary = async () => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('Permission Required', 'Please allow photo library access.');
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      // Important Info keeps high image quality, but still allows the user
      // to crop screenshots/photos before saving them.
      allowsEditing: true,
      quality: 1
    });

    if (!result.canceled && result.assets?.length > 0) {
      setImageUri(await prepareHighQualityInfoImage(result.assets[0].uri));
    }
  };

  const takePhotoWithCamera = async () => {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('Permission Required', 'Please allow camera access.');
      return;
    }

    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ['images'],
      // After taking a picture, the device crop screen opens before the image is saved.
      allowsEditing: true,
      quality: 1
    });
    if (!result.canceled && result.assets?.length > 0) {
      setImageUri(await prepareHighQualityInfoImage(result.assets[0].uri));
    }
  };

  const saveInfoItem = async () => {
    const cleanTitle = title.trim();
    if (!cleanTitle) {
      Alert.alert('Required Field', 'Please enter a title before saving.');
      return;
    }

    try {
      setSaving(true);
      await StorageService.saveImportantInfoItem({
        ...(editingItem || {}),
        title: cleanTitle,
        body: body.trim(),
        imageUri
      });
      setModalVisible(false);
      await loadInfo();
    } catch (error) {
      console.error('Important info save error:', error);
      Alert.alert('Error', 'Could not save this important information item.');
    } finally {
      setSaving(false);
    }
  };

  const deleteInfoItem = (item) => {
    Alert.alert('Delete Item', `Delete "${item.title}"?`, [
      { text: 'Cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try {
            await StorageService.deleteImportantInfoItem(item.id);
            await loadInfo();
          } catch (error) {
            console.error('Important info delete error:', error);
            Alert.alert('Error', 'Could not delete this item.');
          }
        }
      }
    ]);
  };

  const renderThumbnailCard = (item) => (
    <View style={styles.card}>
      <TouchableOpacity
        activeOpacity={item.imageUri ? 0.85 : 1}
        onPress={() => openImageViewer(item)}
        accessibilityRole={item.imageUri ? 'button' : 'none'}
        accessibilityLabel={item.imageUri ? `Open ${item.title} image full screen` : undefined}
      >
        {item.imageUri ? (
          <View>
            <Image source={{ uri: item.imageUri }} style={styles.cardImage} resizeMode="contain" />
            <View style={styles.tapHintBadge}>
              <Text style={styles.tapHintText}>Tap to view full screen</Text>
            </View>
          </View>
        ) : (
          <View style={styles.noImageBox}><Text style={styles.noImageText}>No Photo</Text></View>
        )}
      </TouchableOpacity>

      <TouchableOpacity activeOpacity={item.imageUri ? 0.85 : 1} onPress={() => openImageViewer(item)}>
        <View style={styles.cardBody}>
          <Text style={styles.cardTitle}>{item.title}</Text>
          {item.body ? <Text style={styles.cardText} numberOfLines={4}>{item.body}</Text> : <Text style={styles.cardTextMuted}>No text notes.</Text>}
        </View>
      </TouchableOpacity>

      {isEditMode ? (
        <View style={styles.cardActions}>
          <TouchableOpacity style={styles.editButton} onPress={() => openEditModal(item)}><Text style={styles.actionText}>Edit</Text></TouchableOpacity>
          <TouchableOpacity style={styles.deleteButton} onPress={() => deleteInfoItem(item)}><Text style={styles.actionText}>Delete</Text></TouchableOpacity>
        </View>
      ) : null}
    </View>
  );

  const renderTitleOnlyCard = (item) => (
    <TouchableOpacity
      style={styles.titleOnlyCard}
      activeOpacity={item.imageUri ? 0.85 : 1}
      onPress={() => openImageViewer(item)}
    >
      <View style={styles.titleOnlyTextArea}>
        <Text style={styles.titleOnlyTitle}>{item.title}</Text>
        <Text style={styles.titleOnlySubtitle}>{item.imageUri ? 'Tap to open image' : 'Text note only'}</Text>
      </View>
      {isEditMode ? (
        <View style={styles.titleOnlyActions}>
          <TouchableOpacity style={styles.titleOnlyEditButton} onPress={() => openEditModal(item)}><Text style={styles.titleOnlyActionText}>Edit</Text></TouchableOpacity>
          <TouchableOpacity style={styles.titleOnlyDeleteButton} onPress={() => deleteInfoItem(item)}><Text style={styles.titleOnlyActionText}>Delete</Text></TouchableOpacity>
        </View>
      ) : null}
    </TouchableOpacity>
  );

  if (loading) {
    return (
      <SafeAreaView style={[styles.container, styles.centered]} edges={['left', 'right', 'bottom']}>
        <ActivityIndicator size="large" color="#64ffda" />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['left', 'right', 'bottom']}>
      <View style={styles.headerRow}>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>IMPORTANT INFO</Text>
          <Text style={styles.subtitle}>Reference photos and notes for the team.</Text>
        </View>
        {canEditSharedData ? (
          <>
            <TouchableOpacity
              style={[styles.gearButton, isEditMode && styles.gearButtonActive]}
              onPress={() => setIsEditMode((currentValue) => !currentValue)}
              accessibilityRole="button"
              accessibilityLabel="Toggle Important Info edit mode"
            >
              <Text style={styles.gearButtonText}>⚙️</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.addButton} onPress={openNewModal}>
              <Text style={styles.addButtonText}>+ New</Text>
            </TouchableOpacity>
          </>
        ) : null}
      </View>

      <View style={styles.viewToggleRow}>
        <TouchableOpacity
          style={[styles.viewToggleButton, viewMode === 'thumbnail' && styles.viewToggleButtonActive]}
          onPress={() => setViewMode('thumbnail')}
        >
          <Text style={[styles.viewToggleText, viewMode === 'thumbnail' && styles.viewToggleTextActive]}>Thumbnail</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.viewToggleButton, viewMode === 'title' && styles.viewToggleButtonActive]}
          onPress={() => setViewMode('title')}
        >
          <Text style={[styles.viewToggleText, viewMode === 'title' && styles.viewToggleTextActive]}>Title Only</Text>
        </TouchableOpacity>
      </View>

      {isEditMode ? <Text style={styles.editModeNotice}>Edit mode is active. Edit and delete actions are now visible.</Text> : null}

      <FlatList
        data={sortedItems}
        keyExtractor={(item) => item.id}
        contentContainerStyle={{ paddingBottom: 40 }}
        ListEmptyComponent={<Text style={styles.emptyText}>No important information has been added yet.</Text>}
        renderItem={({ item }) => viewMode === 'thumbnail' ? renderThumbnailCard(item) : renderTitleOnlyCard(item)}
      />

      <Modal visible={viewerVisible} transparent animationType="fade" onRequestClose={closeImageViewer}>
        <SafeAreaView style={styles.viewerOverlay} edges={['top', 'left', 'right', 'bottom']}>
          <View style={styles.viewerHeader}>
            <View style={{ flex: 1 }}>
              <Text style={styles.viewerTitle} numberOfLines={1}>{viewerItem?.title || 'Important Info Image'}</Text>
              <Text style={styles.viewerSubtitle}>Pinch with two fingers to zoom. Drag when zoomed. Double tap to zoom/reset.</Text>
            </View>
            <TouchableOpacity style={styles.viewerCloseButton} onPress={closeImageViewer}>
              <Text style={styles.viewerCloseText}>×</Text>
            </TouchableOpacity>
          </View>

          <View style={styles.viewerStage} {...pinchResponder.panHandlers}>
            {viewerItem?.imageUri ? (
              <Image
                source={{ uri: viewerItem.imageUri }}
                style={[
                  styles.viewerImage,
                  {
                    transform: [
                      { translateX: imageTranslate.x },
                      { translateY: imageTranslate.y },
                      { scale: imageScale }
                    ]
                  }
                ]}
                resizeMode="contain"
              />
            ) : null}
          </View>
        </SafeAreaView>
      </Modal>

      <Modal visible={modalVisible} transparent animationType="fade" onRequestClose={() => setModalVisible(false)}>
        <View style={styles.modalOverlay}>
          <SafeAreaView style={styles.modalSafeArea} edges={['top', 'left', 'right', 'bottom']}>
            <View style={styles.modalContent}>
              <ScrollView showsVerticalScrollIndicator={false}>
                <Text style={styles.modalTitle}>{editingItem ? 'EDIT IMPORTANT INFO' : 'NEW IMPORTANT INFO'}</Text>

                {imageUri ? <Image source={{ uri: imageUri }} style={styles.modalImage} resizeMode="contain" /> : <View style={styles.modalImagePlaceholder}><Text style={styles.noImageText}>No Photo</Text></View>}
                <Text style={styles.imageQualityNote}>Full image view is enabled here. Photos and screenshots are saved in higher quality only for Important Info.</Text>
                <View style={styles.imageButtonRow}>
                  <TouchableOpacity style={styles.imageButton} onPress={pickImageFromLibrary}><Text style={styles.imageButtonText}>📁 Gallery</Text></TouchableOpacity>
                  <TouchableOpacity style={styles.imageButton} onPress={takePhotoWithCamera}><Text style={styles.imageButtonText}>📷 Camera</Text></TouchableOpacity>
                </View>
                {imageUri ? <TouchableOpacity style={styles.removePhotoButton} onPress={() => setImageUri('')}><Text style={styles.removePhotoText}>Remove Photo</Text></TouchableOpacity> : null}

                <Text style={styles.inputLabel}>Title:</Text>
                <TextInput style={styles.input} value={title} onChangeText={setTitle} placeholder="e.g.: Ground Cable Table" placeholderTextColor="#6b7280" />

                <Text style={styles.inputLabel}>Text / Notes:</Text>
                <TextInput style={[styles.input, styles.bodyInput]} value={body} onChangeText={setBody} placeholder="Add useful notes, numbers, or explanation here." placeholderTextColor="#6b7280" multiline />
              </ScrollView>

              <View style={styles.modalActions}>
                <TouchableOpacity style={styles.cancelButton} onPress={() => setModalVisible(false)}><Text style={styles.cancelText}>Cancel</Text></TouchableOpacity>
                <TouchableOpacity style={styles.saveButton} onPress={saveInfoItem} disabled={saving}><Text style={styles.saveText}>{saving ? 'Saving...' : 'Save'}</Text></TouchableOpacity>
              </View>
            </View>
          </SafeAreaView>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a192f', padding: 15 },
  centered: { justifyContent: 'center', alignItems: 'center' },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  title: { color: '#64ffda', fontSize: 20, fontWeight: '900' },
  subtitle: { color: '#8892b0', marginTop: 3, fontSize: 12 },
  gearButton: { width: 42, height: 42, borderRadius: 21, backgroundColor: '#172a45', borderWidth: 1, borderColor: '#233554', justifyContent: 'center', alignItems: 'center', marginRight: 8 },
  gearButtonActive: { borderColor: '#64ffda', backgroundColor: '#0f766e' },
  gearButtonText: { fontSize: 20 },
  addButton: { backgroundColor: '#007bff', paddingVertical: 10, paddingHorizontal: 14, borderRadius: 12, borderWidth: 1, borderColor: '#00d2ff' },
  addButtonText: { color: '#fff', fontWeight: '900' },
  viewToggleRow: { flexDirection: 'row', backgroundColor: '#112240', borderRadius: 14, padding: 5, borderWidth: 1, borderColor: '#233554', marginBottom: 10 },
  viewToggleButton: { flex: 1, paddingVertical: 10, borderRadius: 10, alignItems: 'center' },
  viewToggleButtonActive: { backgroundColor: '#0275d8' },
  viewToggleText: { color: '#8892b0', fontWeight: '900', fontSize: 12 },
  viewToggleTextActive: { color: '#fff' },
  editModeNotice: { color: '#64ffda', fontSize: 11, fontWeight: '800', marginBottom: 10, textAlign: 'center' },
  emptyText: { color: '#8892b0', textAlign: 'center', marginTop: 60, fontStyle: 'italic' },
  card: { backgroundColor: '#112240', borderRadius: 16, padding: 12, marginBottom: 12, borderWidth: 1, borderColor: '#233554' },
  cardImage: { width: '100%', height: 260, borderRadius: 12, marginBottom: 12, backgroundColor: '#0a192f' },
  tapHintBadge: { position: 'absolute', right: 10, bottom: 20, backgroundColor: 'rgba(10, 25, 47, 0.86)', paddingVertical: 5, paddingHorizontal: 9, borderRadius: 999, borderWidth: 1, borderColor: '#64ffda55' },
  tapHintText: { color: '#64ffda', fontSize: 10, fontWeight: '900' },
  noImageBox: { width: '100%', height: 150, borderRadius: 12, marginBottom: 12, backgroundColor: '#172a45', justifyContent: 'center', alignItems: 'center' },
  noImageText: { color: '#8892b0', fontWeight: '700', fontSize: 12 },
  cardBody: { flex: 1 },
  cardTitle: { color: '#e6f1ff', fontWeight: '900', fontSize: 15 },
  cardText: { color: '#ccd6f6', marginTop: 5, fontSize: 12, lineHeight: 17 },
  cardTextMuted: { color: '#64748b', marginTop: 5, fontStyle: 'italic', fontSize: 12 },
  cardActions: { flexDirection: 'row', marginTop: 10 },
  editButton: { backgroundColor: '#0275d8', paddingVertical: 8, paddingHorizontal: 13, borderRadius: 10, marginRight: 8 },
  deleteButton: { backgroundColor: '#e74c3c', paddingVertical: 8, paddingHorizontal: 13, borderRadius: 10 },
  actionText: { color: '#fff', fontWeight: '900', fontSize: 12 },
  titleOnlyCard: { backgroundColor: '#112240', borderRadius: 14, padding: 14, marginBottom: 10, borderWidth: 1, borderColor: '#233554', flexDirection: 'row', alignItems: 'center' },
  titleOnlyTextArea: { flex: 1 },
  titleOnlyTitle: { color: '#e6f1ff', fontSize: 15, fontWeight: '900' },
  titleOnlySubtitle: { color: '#8892b0', fontSize: 11, marginTop: 3, fontWeight: '700' },
  titleOnlyActions: { flexDirection: 'row', marginLeft: 8 },
  titleOnlyEditButton: { backgroundColor: '#0275d8', paddingVertical: 7, paddingHorizontal: 10, borderRadius: 9, marginRight: 6 },
  titleOnlyDeleteButton: { backgroundColor: '#e74c3c', paddingVertical: 7, paddingHorizontal: 10, borderRadius: 9 },
  titleOnlyActionText: { color: '#fff', fontWeight: '900', fontSize: 11 },
  viewerOverlay: { flex: 1, backgroundColor: '#020c1b' },
  viewerHeader: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#233554' },
  viewerTitle: { color: '#e6f1ff', fontSize: 16, fontWeight: '900' },
  viewerSubtitle: { color: '#8892b0', fontSize: 11, marginTop: 2, fontWeight: '700' },
  viewerCloseButton: { width: 40, height: 40, borderRadius: 20, backgroundColor: '#112240', borderWidth: 1, borderColor: '#64ffda', justifyContent: 'center', alignItems: 'center', marginLeft: 12 },
  viewerCloseText: { color: '#64ffda', fontSize: 28, fontWeight: '700', marginTop: -2 },
  viewerStage: { flex: 1, justifyContent: 'center', alignItems: 'center', overflow: 'hidden' },
  viewerImage: { width: VIEWER_WIDTH - 24, height: VIEWER_HEIGHT - 150, backgroundColor: '#020c1b' },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(2, 12, 27, 0.82)', justifyContent: 'center', alignItems: 'center' },
  modalSafeArea: { width: '100%', alignItems: 'center' },
  modalContent: { width: '92%', maxHeight: '92%', backgroundColor: '#ccd6f6', borderRadius: 20, padding: 20 },
  modalTitle: { color: '#0a192f', fontWeight: '900', fontSize: 18, textAlign: 'center', marginBottom: 14 },
  modalImage: { width: '100%', height: 360, borderRadius: 16, backgroundColor: '#e2e8f0', marginBottom: 8 },
  modalImagePlaceholder: { width: '100%', height: 220, borderRadius: 16, backgroundColor: '#e2e8f0', justifyContent: 'center', alignItems: 'center', marginBottom: 8 },
  imageQualityNote: { color: '#334155', fontSize: 11, lineHeight: 16, textAlign: 'center', marginBottom: 12, fontWeight: '700' },
  imageButtonRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 10 },
  imageButton: { backgroundColor: '#172a45', borderRadius: 12, padding: 12, width: '48%', alignItems: 'center' },
  imageButtonText: { color: '#64ffda', fontWeight: '900' },
  removePhotoButton: { alignItems: 'center', marginBottom: 10 },
  removePhotoText: { color: '#e74c3c', fontWeight: '900' },
  inputLabel: { color: '#0a192f', fontWeight: '900', marginTop: 10, marginBottom: 5 },
  input: { backgroundColor: '#fff', color: '#0a192f', borderRadius: 12, borderWidth: 1, borderColor: '#cbd5e1', padding: 12 },
  bodyInput: { minHeight: 120, textAlignVertical: 'top' },
  modalActions: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 16 },
  cancelButton: { backgroundColor: '#8892b0', padding: 13, borderRadius: 12, width: '48%', alignItems: 'center' },
  saveButton: { backgroundColor: '#0275d8', padding: 13, borderRadius: 12, width: '48%', alignItems: 'center' },
  cancelText: { color: '#fff', fontWeight: '900' },
  saveText: { color: '#fff', fontWeight: '900' }
});

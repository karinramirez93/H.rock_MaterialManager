/**
 * CatalogManagerScreen
 * --------------------
 * Uses the same family-based catalog layout as the normal catalog screen, but
 * switches the behavior to catalog maintenance. Repetitive materials such as
 * EMT Pipe, nipples, LB, LL, bushings, couplings, and other same-name items with
 * different sizes appear as one family card. Editing that card updates the
 * shared family information: image, name, description, category, and units.
 */
import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { StyleSheet, Text, View, FlatList, TextInput, TouchableOpacity, Modal, ActivityIndicator, Image, Alert, ScrollView, BackHandler, RefreshControl, KeyboardAvoidingView, Platform, Dimensions } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { StorageService } from '../database/storage';
import CachedCatalogImage from '../components/CachedCatalogImage';
import { useFocusEffect } from '@react-navigation/native';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import { GestureHandlerRootView, GestureDetector, Gesture } from 'react-native-gesture-handler';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
} from 'react-native-reanimated';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');

const ImageZoomModal = ({ visible, imageUri, onClose }) => {
  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);

  const pinchGesture = Gesture.Pinch()
    .onUpdate((event) => {
      scale.value = savedScale.value * event.scale;
    })
    .onEnd(() => {
      scale.value = withSpring(1);
      savedScale.value = 1;
    });

  const rStyle = useAnimatedStyle(() => {
    return {
      transform: [{ scale: scale.value }],
    };
  });

  if (!imageUri) return null;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <GestureHandlerRootView style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.9)' }}>
        <TouchableOpacity
          style={styles.zoomCloseButton}
          onPress={onClose}
        >
          <Text style={styles.zoomCloseText}>✕ Close</Text>
        </TouchableOpacity>
        <GestureDetector gesture={pinchGesture}>
          <Animated.View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
            <Animated.Image
              source={{ uri: imageUri }}
              style={[{ width: SCREEN_WIDTH, height: SCREEN_WIDTH, backgroundColor: '#000' }, rStyle]}
              resizeMode="contain"
            />
          </Animated.View>
        </GestureDetector>
        <View style={styles.zoomInstruction}>
          <Text style={styles.zoomInstructionText}>Pinch to zoom in/out</Text>
        </View>
      </GestureHandlerRootView>
    </Modal>
  );
};

const UNIT_OPTIONS = ['Unit', 'Box', 'Bundle', 'Reel', 'Length (ft)'];

const getMaterialDisplayName = (material) => {
  const sizeText = material?.size && material.size !== 'N/A' ? ` ${material.size}` : '';
  return `${material?.name || 'Unnamed Material'}${sizeText}`;
};

const convertSizeToNumber = (size) => {
  if (!size || size === 'N/A') return Number.MAX_SAFE_INTEGER;
  const cleanSize = String(size).replace(/inches|inch|in\.?/gi, '').replace(/”|“/g, '"').replace(/"/g, '').trim().replace(/\s+/g, ' ');
  const mixedNumberMatch = cleanSize.match(/^(\d+)(?:\s+(\d+)\/(\d+))?$/);
  if (mixedNumberMatch) {
    const wholeNumber = Number(mixedNumberMatch[1]);
    const numerator = mixedNumberMatch[2] ? Number(mixedNumberMatch[2]) : 0;
    const denominator = mixedNumberMatch[3] ? Number(mixedNumberMatch[3]) : 1;
    return wholeNumber + (denominator ? numerator / denominator : 0);
  }
  const fractionMatch = cleanSize.match(/^(\d+)\/(\d+)$/);
  if (fractionMatch) {
    const numerator = Number(fractionMatch[1]);
    const denominator = Number(fractionMatch[2]);
    return denominator ? numerator / denominator : Number.MAX_SAFE_INTEGER;
  }
  const decimalValue = Number(cleanSize);
  return Number.isFinite(decimalValue) ? decimalValue : Number.MAX_SAFE_INTEGER;
};

const getSortableSizeValue = (material) => {
  if (material?.size && material.size !== 'N/A') return convertSizeToNumber(material.size);
  const displayName = getMaterialDisplayName(material);
  const sizeMatch = displayName.match(/(?:^|\s)((?:\d+\s+)?\d+\/\d+|\d+(?:\.\d+)?)"?\s*$/);
  return sizeMatch ? convertSizeToNumber(sizeMatch[1]) : Number.MAX_SAFE_INTEGER;
};

const getSortableBaseName = (material) => {
  return (material?.name || getMaterialDisplayName(material) || 'Unnamed Material')
    .replace(/\s+((?:\d+\s+)?\d+\/\d+|\d+(?:\.\d+)?)"?\s*$/, '')
    .trim()
    .toLowerCase();
};

const CONDUCTOR_COLOR_NAMES = ['Black', 'Red', 'Blue', 'Orange', 'Brown', 'Yellow', 'White', 'Green', 'Gray', 'Grey', 'Purple'];

const getConductorColor = (material) => {
  const materialCategory = String(material?.category || '').toLowerCase();
  const variantType = String(material?.variantType || '').toLowerCase();
  const materialName = String(material?.name || '').trim();

  const looksLikeWire =
    materialCategory === 'conductors' ||
    materialCategory === 'wire' ||
    materialName.toLowerCase().includes('wire') ||
    variantType === 'colors';

  if (!looksLikeWire) return '';

  const candidateFields = [
    material?.color,
    material?.variant,
    material?.size,
    material?.name
  ];

  for (const candidate of candidateFields) {
    const candidateText = String(candidate || '').trim();
    if (!candidateText) continue;

    const matchingColor = CONDUCTOR_COLOR_NAMES.find((color) => {
      const colorPattern = new RegExp(`\\b${color}\\b`, 'i');
      return colorPattern.test(candidateText);
    });

    if (matchingColor) {
      return matchingColor === 'Grey' ? 'Gray' : matchingColor;
    }
  }

  return '';
};

const getConductorFamilyBaseName = (material) => {
  const color = getConductorColor(material);
  const materialName = String(material?.name || '').trim();
  if (!color) return getSortableBaseName(material);
  return materialName.replace(new RegExp(`\\s+${color}$`, 'i'), '').trim().toLowerCase();
};

const isConductorColorFamily = (material) => Boolean(getConductorColor(material));

const sortCatalogByNameAndSize = (items) => [...items].sort((a, b) => {
  const baseNameComparison = getSortableBaseName(a).localeCompare(getSortableBaseName(b));
  if (baseNameComparison !== 0) return baseNameComparison;
  const sizeComparison = getSortableSizeValue(a) - getSortableSizeValue(b);
  if (sizeComparison !== 0) return sizeComparison;
  return getMaterialDisplayName(a).localeCompare(getMaterialDisplayName(b));
});

const getMaterialFamilyKey = (material) => {
  const categoryKey = String(material?.category || 'Others').toLowerCase();
  const explicitFamilyName = String(material?.familyName || '').trim();
  if (explicitFamilyName) return `${categoryKey}::${explicitFamilyName.toLowerCase()}`;
  if (isConductorColorFamily(material)) {
    return `${categoryKey}::${getConductorFamilyBaseName(material)}`;
  }
  return `${categoryKey}::${getSortableBaseName(material)}`;
};

const getSharedFamilyImageUri = (variants) => {
  // Priority 1: Explicit group cover designated by the manager
  const coverOwner = (variants || []).find((v) => Boolean(v?.groupCoverUri));
  if (coverOwner?.groupCoverUri) return coverOwner.groupCoverUri;

  // Priority 2: Fallback to the first variant image if no explicit cover is set
  const imageOwner = (variants || []).find((variant) => Boolean(variant?.imageUri));
  return imageOwner?.imageUri || '';
};

const buildCatalogDisplayItems = (items) => {
  const familyMap = new Map();

  (items || []).forEach((material) => {
    const familyKey = getMaterialFamilyKey(material);
    if (!familyMap.has(familyKey)) familyMap.set(familyKey, []);
    familyMap.get(familyKey).push(material);
  });

  const displayItems = Array.from(familyMap.entries()).map(([familyKey, variants]) => {
    const sortedVariants = sortCatalogByNameAndSize(variants);
    const firstVariant = sortedVariants[0] || {};
    const hasColorVariants = sortedVariants.some((variant) => isConductorColorFamily(variant)) && sortedVariants.length > 1;
    const hasSizeVariants = sortedVariants.some((variant) => variant?.size && variant.size !== 'N/A') && sortedVariants.length > 1;
    const isExplicitFamily = Boolean(firstVariant.familyName) && sortedVariants.length > 1;

    if (!hasColorVariants && !hasSizeVariants && !isExplicitFamily) {
      return {
        ...firstVariant,
        variants: sortedVariants,
        familyDisplayMode: firstVariant.familyDisplayMode || 'grid',
        imageUri: firstVariant.imageUri || getSharedFamilyImageUri(sortedVariants)
      };
    }

    return {
      ...firstVariant,
      name: (firstVariant.familyName || firstVariant.name || '').replace(/\s+(Black|Red|Blue|Orange|Brown|Yellow|White|Green|Gray|Grey|Purple)$/i, '').trim(),
      id: `family-${familyKey}`,
      isFamilyGroup: true,
      familyKey,
      variants: sortedVariants,
      size: 'N/A',
      imageUri: getSharedFamilyImageUri(sortedVariants),
      description: firstVariant.groupDescription || '',
      familyDisplayMode: sortedVariants.find((variant) => variant.familyDisplayMode)?.familyDisplayMode || 'grid',
      availableSizes: hasSizeVariants ? sortedVariants.map((variant) => variant.size).filter((size) => size && size !== 'N/A') : [],
      availableColors: hasColorVariants ? sortedVariants.map((variant) => getConductorColor(variant)).filter(Boolean) : []
    };
  });

  return sortCatalogByNameAndSize(displayItems);
};

const getDefaultAllowedUnitsByCategory = (category) => {
  switch ((category || '').toLowerCase()) {
    case 'conductors':
      return ['Unit', 'Reel', 'Length (ft)', 'Length (in)', 'Bottle'];
    case 'conduits':
      return ['Unit', 'Bundle', 'Length (ft)', 'Length (in)', 'Bottle'];
    case 'devices':
      return ['Unit', 'Box', 'Bottle'];
    case 'tools':
      return ['Unit', 'Box', 'Bottle'];
    case 'boxes':
    case 'connectors':
    case 'fittings':
    case 'others':
    default:
      return ['Unit', 'Box', 'Bundle', 'Bottle'];
  }
};

const getSearchableFamilyText = (item) => {
  const variants = item?.variants || [item];
  return [
    item?.name,
    item?.category,
    item?.description,
    ...(item?.availableSizes || []),
    ...variants.flatMap((variant) => [getMaterialDisplayName(variant), variant?.description, ...(Array.isArray(variant?.keywords) ? variant.keywords : [])])
  ].filter(Boolean).join(' ').toLowerCase();
};

const ITEMS_PER_PAGE = 15;

const QUICK_FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'wire', label: 'Wire' },
  { id: 'pipe', label: 'Pipe' },
  { id: 'connectors', label: 'Connectors' },
  { id: 'fittings', label: 'Fittings' },
  { id: 'boxes', label: 'Boxes' },
  { id: 'devices', label: 'Devices' },
  { id: 'tools', label: 'Tools' }
];

const familyMatchesQuickFilter = (item, filterId) => {
  if (!filterId || filterId === 'all') return true;

  const category = String(item?.category || '').toLowerCase();
  const searchableText = getSearchableFamilyText(item);

  switch (filterId) {
    case 'wire':
      return category === 'conductors' || /\b(wire|conductor|cable|thhn|xhhw)\b/.test(searchableText);
    case 'pipe':
      return category === 'conduits' || /\b(pipe|conduit|emt|rigid|ridgid|sealtite|raceway|tube)\b/.test(searchableText);
    case 'connectors':
      return category === 'connectors' || /\b(connector|connectors|coupling|couplings)\b/.test(searchableText);
    case 'fittings':
      return category === 'fittings' || /\b(fitting|fittings|bushing|cap|nipple|lb|ll|lr|strap|clamp)\b/.test(searchableText);
    case 'boxes':
      return category === 'boxes' || /\b(box|boxes|junction box|device box)\b/.test(searchableText);
    case 'devices':
      return category === 'devices' || /\b(device|devices|switch|receptacle|outlet)\b/.test(searchableText);
    case 'tools':
      return category === 'tools' || /\b(tool|tools|blade|bandsaw|bit|drill)\b/.test(searchableText);
    default:
      return true;
  }
};

export default function CatalogManagerScreen({ navigation, currentUser }) {
  const [categories, setCategories] = useState([]);
  const [unitOptions, setUnitOptions] = useState(['Unit', 'Box', 'Bundle', 'Reel', 'Length (ft)', 'Length (in)', 'Bottle']);
  const [catalog, setCatalog] = useState([]);
  const [filtered, setFiltered] = useState([]);
  const [search, setSearch] = useState('');
  const [activeQuickFilter, setActiveQuickFilter] = useState('all');
  const [sortMode, setSortMode] = useState('name');
  const [menuModalVisible, setMenuModalVisible] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastSyncMessage, setLastSyncMessage] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const listRef = useRef(null);
  const [saving, setSaving] = useState(false);
  const [modalVisible, setModalVisible] = useState(false);
  const [selectedItem, setSelectedItem] = useState(null);
  const [selectedVariants, setSelectedVariants] = useState([]);
  const [editName, setEditName] = useState('');
  const [editCategory, setEditCategory] = useState('Others');
  const [editDescription, setEditDescription] = useState('');
  const [editFamilyDisplayMode, setEditFamilyDisplayMode] = useState('grid');
  const [editForceShowDescription, setEditForceShowDescription] = useState(false);
  const [groupCoverImageUri, setGroupCoverImageUri] = useState('');
  const [editImageUri, setEditImageUri] = useState('');
  const [allowedUnits, setAllowedUnits] = useState(['Unit', 'Bundle']);
  const [variantDrafts, setVariantDrafts] = useState([]);
  const [variantEditorVisible, setVariantEditorVisible] = useState(false);
  const [activeVariantDraftId, setActiveVariantDraftId] = useState(null);
  const [activeVariantName, setActiveVariantName] = useState('');
  const [activeVariantSize, setActiveVariantSize] = useState('');
  const [activeVariantDescription, setActiveVariantDescription] = useState('');
  const [activeVariantForceShowDescription, setActiveVariantForceShowDescription] = useState(false);
  const [activeVariantImageUri, setActiveVariantImageUri] = useState('');
  const [isChangingFamily, setIsChangingFamily] = useState(false);
  const [showGroupCoverPicker, setShowGroupCoverPicker] = useState(false);
  const [showIndividualImagePicker, setShowIndividualImagePicker] = useState(false);
  const [hardDeleteConfirmed, setHardDeleteConfirmed] = useState(false);

  const [isMultiSelectMode, setIsMultiSelectMode] = useState(false);
  const [selectedItems, setSelectedItems] = useState([]);
  const [groupModalVisible, setGroupModalVisible] = useState(false);
  const [targetGroupName, setTargetGroupName] = useState('');
  const [groupSearchText, setGroupSearchText] = useState('');
  const [isMovingToNewGroup, setIsMovingToNewGroup] = useState(true);

  const [zoomVisible, setZoomVisible] = useState(false);
  const [zoomImageUri, setZoomImageUri] = useState('');

  const totalPages = Math.max(1, Math.ceil(filtered.length / ITEMS_PER_PAGE));
  const paginatedFamilies = useMemo(() => {
    const startIndex = (currentPage - 1) * ITEMS_PER_PAGE;
    return filtered.slice(startIndex, startIndex + ITEMS_PER_PAGE);
  }, [filtered, currentPage]);

  useEffect(() => {
    if (currentPage > totalPages) setCurrentPage(totalPages);
  }, [currentPage, totalPages]);

  const goToPage = (pageNumber) => {
    const safePage = Math.min(Math.max(1, pageNumber), totalPages);
    setCurrentPage(safePage);
    requestAnimationFrame(() => listRef.current?.scrollToOffset?.({ offset: 0, animated: true }));
  };

  const canEditSharedData = currentUser?.role === 'owner' || currentUser?.role === 'editor';
  const isOwner = currentUser?.role === 'owner';

  useEffect(() => {
    if (!canEditSharedData) {
      Alert.alert('Viewer Access Only', 'Guest and viewer accounts cannot edit the shared catalog.', [
        { text: 'OK', onPress: () => navigation.goBack() }
      ]);
    }
  }, [canEditSharedData, navigation]);

  const openZoom = (uri) => {
    if (!uri) return;
    setZoomImageUri(uri);
    setZoomVisible(true);
  };

  const filterCatalog = (data, text, selectedQuickFilter = activeQuickFilter, selectedSortMode = sortMode) => {
    let familyItems = buildCatalogDisplayItems(data).filter((item) => familyMatchesQuickFilter(item, selectedQuickFilter));

    // Applying sort
    if (selectedSortMode === 'frequent') {
      familyItems = [...familyItems].sort((a, b) => (b.requestCount || 0) - (a.requestCount || 0));
    } else {
      familyItems = sortCatalogByNameAndSize(familyItems);
    }

    if (!text.trim()) return familyItems;

    const searchText = text.toLowerCase();
    return familyItems.filter((item) => getSearchableFamilyText(item).includes(searchText));
  };

  const applyCatalogToScreen = useCallback((data) => {
    const safeData = Array.isArray(data) ? data : [];
    setCatalog(safeData);
    setFiltered(filterCatalog(safeData, search, activeQuickFilter, sortMode));
    setCurrentPage(1);
  }, [search, activeQuickFilter, sortMode]);

  const loadCatalog = async () => {
    try {
      const [localData, fetchedCategories, fetchedUnits] = await Promise.all([
        StorageService.loadCatalogCache(),
        StorageService.loadCategories(),
        StorageService.loadUnitMeasures()
      ]);
      if (localData.length > 0) {
        applyCatalogToScreen(localData);
        setCategories(fetchedCategories);
        if (fetchedUnits && fetchedUnits.length > 0) setUnitOptions(fetchedUnits);
        setLoading(false);
      }
      const cloudData = await StorageService.syncCatalogIfChanged();
      applyCatalogToScreen(cloudData);
      setLastSyncMessage(`Checked: ${new Date().toLocaleTimeString()}`);
    } catch (error) {
      console.error('Catalog manager load error:', error);
      const fallbackData = await StorageService.loadCatalog();
      applyCatalogToScreen(fallbackData);
      setLastSyncMessage('Offline mode. Showing local catalog.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const refreshCatalogFromFirebase = async () => {
    try {
      setRefreshing(true);
      const cloudData = await StorageService.syncCatalogFromFirebase();
      applyCatalogToScreen(cloudData);
      setLastSyncMessage(`Last sync: ${new Date().toLocaleTimeString()}`);
    } catch (error) {
      console.error('Catalog manager refresh error:', error);
      setLastSyncMessage('Sync failed. Showing local catalog.');
      Alert.alert('Sync Error', 'The app could not refresh Firebase right now.');
    } finally {
      setRefreshing(false);
    }
  };


  const migrateCatalogImagesToThumbnails = async () => {
    if (!isOwner) {
      Alert.alert('Owner Required', 'Only the owner can run image cleanup/migration.');
      return;
    }

    Alert.alert(
      'Optimize Catalog Images',
      'This will convert old large catalog images stored in Realtime Database into small Firebase Storage thumbnails. Important Info images keep their high quality.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Run Optimization',
          onPress: async () => {
            try {
              setRefreshing(true);
              const count = await StorageService.migrateCatalogInlineImagesToStorageThumbnails();
              const cloudData = await StorageService.syncCatalogFromFirebase();
              applyCatalogToScreen(cloudData);
              setLastSyncMessage(`Optimized ${count} image${count === 1 ? '' : 's'} at ${new Date().toLocaleTimeString()}`);
              Alert.alert('Image Optimization Complete', `${count} catalog image${count === 1 ? '' : 's'} optimized.`);
            } catch (error) {
              console.error('Catalog image migration error:', error);
              Alert.alert('Optimization Error', 'Could not optimize catalog images. Check Firebase Storage rules and owner permissions.');
            } finally {
              setRefreshing(false);
            }
          }
        }
      ]
    );
  };

  useFocusEffect(useCallback(() => {
    // Sync on screen open/focus only. No timer polling.
    // Add/edit/delete actions refresh the local cache immediately after the write.
    loadCatalog();
  }, []));

  useFocusEffect(useCallback(() => {
    const handleDeviceBack = () => {
      if (zoomVisible) {
        setZoomVisible(false);
        return true;
      }
      if (variantEditorVisible) {
        setVariantEditorVisible(false);
        return true;
      }
      if (groupModalVisible) {
        setGroupModalVisible(false);
        return true;
      }
      if (modalVisible) {
        setModalVisible(false);
        return true;
      }
      if (menuModalVisible) {
        setMenuModalVisible(false);
        return true;
      }
      if (isMultiSelectMode) {
        setSelectedItems([]);
        setIsMultiSelectMode(false);
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
  }, [navigation, zoomVisible, variantEditorVisible, groupModalVisible, modalVisible, menuModalVisible, isMultiSelectMode]));

  const handleSearch = (text) => {
    setSearch(text);
    setFiltered(filterCatalog(catalog, text, activeQuickFilter));
    setCurrentPage(1);
  };

  const changeQuickFilter = (newQuickFilter) => {
    setActiveQuickFilter(newQuickFilter);
    setFiltered(filterCatalog(catalog, search, newQuickFilter, sortMode));
    setCurrentPage(1);
    setMenuModalVisible(false);
  };

  const changeSortMode = (newSortMode) => {
    setSortMode(newSortMode);
    setFiltered(filterCatalog(catalog, search, activeQuickFilter, newSortMode));
    setCurrentPage(1);
    setMenuModalVisible(false);
  };

  const resizeSelectedImage = async (uri) => {
    const resizedImage = await ImageManipulator.manipulateAsync(uri, [{ resize: { width: 180 } }], { compress: 0.28, format: ImageManipulator.SaveFormat.JPEG, base64: true });
    return `data:image/jpeg;base64,${resizedImage.base64}`;
  };

  const pickGroupCoverImage = async () => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) return Alert.alert('Permission Required', 'Please allow photo library access.');
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsEditing: true, quality: 0.8 });
    if (!result.canceled && result.assets?.length > 0) setGroupCoverImageUri(await resizeSelectedImage(result.assets[0].uri));
  };

  const takeGroupCoverPhoto = async () => {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) return Alert.alert('Permission Required', 'Please allow camera access.');
    const result = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], allowsEditing: true, quality: 0.8 });
    if (!result.canceled && result.assets?.length > 0) setGroupCoverImageUri(await resizeSelectedImage(result.assets[0].uri));
  };

  const pickImage = async () => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) return Alert.alert('Permission Required', 'Please allow photo library access.');
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsEditing: true, quality: 0.8 });
    if (!result.canceled && result.assets?.length > 0) setEditImageUri(await resizeSelectedImage(result.assets[0].uri));
  };

  const takePhoto = async () => {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) return Alert.alert('Permission Required', 'Please allow camera access.');
    const result = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], allowsEditing: true, quality: 0.8 });
    if (!result.canceled && result.assets?.length > 0) setEditImageUri(await resizeSelectedImage(result.assets[0].uri));
  };

  const toggleMultiSelectMode = () => {
    setIsMultiSelectMode(!isMultiSelectMode);
    setSelectedItems([]);
  };

  const toggleItemSelection = (item) => {
    setSelectedItems((prev) => {
      const itemId = item.id || item.familyKey;
      const isSelected = prev.some((s) => (s.id || s.familyKey) === itemId);
      if (isSelected) {
        return prev.filter((s) => (s.id || s.familyKey) !== itemId);
      }
      return [...prev, item];
    });
  };

  const handleApplyGrouping = async () => {
    const finalGroupName = targetGroupName.trim();
    if (!finalGroupName) {
      Alert.alert('Required', 'Please enter a group name or select an existing one.');
      return;
    }

    try {
      setSaving(true);

      // Collect all individual material variants from the selected display items
      const allVariantsToMove = selectedItems.flatMap(item => item.variants || [item]);

      if (allVariantsToMove.length === 0) return;

      const userLabel = await StorageService.getCurrentAuditUserLabel?.() || 'manager';
      const now = new Date().toISOString();

      // We update the familyName for all selected variants.
      const updatedVariants = allVariantsToMove.map(variant => ({
        ...variant,
        familyName: finalGroupName,
        updatedAt: now,
        updatedBy: userLabel
      }));

      // Reuse updateMaterialFamily which handles PATCHing multiple materials
      await StorageService.updateMaterialFamily(updatedVariants);

      setGroupModalVisible(false);
      setIsMultiSelectMode(false);
      setSelectedItems([]);
      setTargetGroupName('');
      await loadCatalog();
      Alert.alert('Success', `Moved ${updatedVariants.length} items to group "${finalGroupName}".`);
    } catch (error) {
      console.error('Error grouping materials:', error);
      Alert.alert('Error', 'Could not group the selected materials.');
    } finally {
      setSaving(false);
    }
  };

  const openEditModal = (item) => {
    const variants = item?.variants?.length ? item.variants : [item];
    const firstVariant = variants[0] || item;
    setSelectedItem(item);
    setSelectedVariants(variants);

    // If it's a family group, use the grouping name (item.name),
    // otherwise use the material's familyName or name.
    const initialFamilyName = item.isFamilyGroup ? item.name : (firstVariant.familyName || firstVariant.name || '');
    setEditName(initialFamilyName);
    setTargetGroupName(initialFamilyName);
    setIsChangingFamily(false);
    setIsMovingToNewGroup(true);
    setGroupSearchText('');

    // Find if any variant has a designated group cover
    const coverOwner = variants.find(v => v.groupCoverUri);
    const coverUri = coverOwner?.groupCoverUri || item.imageUri || '';
    setGroupCoverImageUri(coverUri);
    setShowGroupCoverPicker(Boolean(coverUri));

    setEditCategory(firstVariant.category || 'Others');
    setEditDescription(firstVariant.groupDescription || '');
    setEditFamilyDisplayMode((variants.find((variant) => variant.familyDisplayMode)?.familyDisplayMode || firstVariant.familyDisplayMode) === 'list' ? 'list' : 'grid');
    setEditForceShowDescription(false);
    setEditImageUri(item.imageUri || getSharedFamilyImageUri(variants) || '');
    setAllowedUnits(Array.isArray(firstVariant.allowedUnits) && firstVariant.allowedUnits.length > 0 ? firstVariant.allowedUnits.map((u) => u === 'Rolls' ? 'Reel' : u) : getDefaultAllowedUnitsByCategory(firstVariant.category));
    setVariantDrafts(variants.map((variant) => ({
      id: variant.id,
      name: variant.name || '',
      size: variant.size && variant.size !== 'N/A' ? variant.size : '',
      description: variant.description || '',
      forceShowDescription: variant.forceShowDescription === true,
      imageUri: variant.imageUri || '',
      imageStoragePath: variant.imageStoragePath || '',
      original: variant
    })));
    setHardDeleteConfirmed(false);
    setModalVisible(true);
  };

  const toggleAllowedUnit = (unit) => {
    setAllowedUnits((current) => current.includes(unit) ? current.filter((u) => u !== unit) : [...current, unit]);
  };
  const pickVariantImage = async () => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) return Alert.alert('Permission Required', 'Please allow photo library access.');
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsEditing: true, quality: 0.8 });
    if (!result.canceled && result.assets?.length > 0) setActiveVariantImageUri(await resizeSelectedImage(result.assets[0].uri));
  };

  const takeVariantPhoto = async () => {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) return Alert.alert('Permission Required', 'Please allow camera access.');
    const result = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], allowsEditing: true, quality: 0.8 });
    if (!result.canceled && result.assets?.length > 0) setActiveVariantImageUri(await resizeSelectedImage(result.assets[0].uri));
  };

  const openVariantEditor = (draft) => {
    setActiveVariantDraftId(draft.id);
    setActiveVariantName(draft.name || '');
    setActiveVariantSize(draft.size || '');
    setActiveVariantDescription(draft.description || '');
    setActiveVariantForceShowDescription(draft.forceShowDescription === true);
    const variantImg = draft.imageUri !== undefined ? draft.imageUri : (draft.original?.imageUri || '');
    const variantStoragePath = draft.imageStoragePath || draft.original?.imageStoragePath || '';
    setActiveVariantImageUri(variantImg);
    setShowIndividualImagePicker(Boolean(variantImg || variantStoragePath));
    setVariantEditorVisible(true);
  };

  const saveVariantEditor = () => {
    if (!activeVariantDraftId) return;
    setVariantDrafts((current) => current.map((draft) => {
      if (draft.id !== activeVariantDraftId) return draft;

      const nextImageUri = showIndividualImagePicker ? (activeVariantImageUri || '') : '';
      const previousImageUri = draft.imageUri !== undefined ? draft.imageUri : (draft.original?.imageUri || '');
      const previousStoragePath = draft.imageStoragePath || draft.original?.imageStoragePath || '';
      const imageWasChanged = nextImageUri !== previousImageUri;

      return {
        ...draft,
        name: activeVariantName.trim(),
        size: activeVariantSize.trim(),
        description: activeVariantDescription.trim(),
        forceShowDescription: activeVariantForceShowDescription,
        imageUri: nextImageUri,
        imageStoragePath: showIndividualImagePicker && !imageWasChanged ? previousStoragePath : ''
      };
    }));
    setVariantEditorVisible(false);
  };


  const updateVariantDraft = (variantId, field, value) => {
    setVariantDrafts((current) => current.map((draft) => draft.id === variantId ? { ...draft, [field]: value } : draft));
  };

  const deleteSingleVariant = async (variantId) => {
    if (!isOwner) {
      Alert.alert('Owner Required', 'Only owners can delete materials from the catalog.');
      return;
    }
    const draft = variantDrafts.find((item) => item.id === variantId);
    Alert.alert('Permanent Delete', `Permanently delete ${draft?.size || draft?.name || 'this material'} from the catalog? This cannot be undone.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try {
            setSaving(true);
            await StorageService.permanentDeleteMaterial(variantId);
            const remainingDrafts = variantDrafts.filter((item) => item.id !== variantId);
            const remainingVariants = selectedVariants.filter((item) => item.id !== variantId);
            setVariantDrafts(remainingDrafts);
            setSelectedVariants(remainingVariants);
            if (remainingDrafts.length === 0) {
              setModalVisible(false);
            }
            await loadCatalog();
            StorageService.reclaimDiskSpace?.();
          } catch (error) {
            console.error('Error deleting family variant:', error);
            Alert.alert('Error', 'Could not delete this material from the catalog.');
          } finally {
            setSaving(false);
          }
        }
      }
    ]);
  };

  const handleEditNameChange = (newName) => {
    setEditName(newName);
  };

  const saveEdits = async () => {
    if (!selectedVariants.length) return;
    if (!editName.trim()) return Alert.alert('Required Field', 'Please enter the material name.');
    if (allowedUnits.length === 0) return Alert.alert('Required Field', 'Please select at least one unit of measure.');

    try {
      setSaving(true);
      const draftById = new Map(variantDrafts.map((draft) => [draft.id, draft]));
      const variantsToUpdate = selectedVariants.map((variant, index) => {
        const draft = draftById.get(variant.id) || {};

        // Use individual variant image if it exists in draft, otherwise use original
        const resolvedVariantImageUri = draft.imageUri !== undefined
          ? draft.imageUri
          : (variant.imageUri || '');
        const resolvedVariantImageStoragePath = draft.imageStoragePath !== undefined
          ? draft.imageStoragePath
          : (variant.imageStoragePath || '');

        return {
          ...variant,
          name: (draft.name || variant.name || editName).trim(),
          familyName: editName.trim(),
          category: editCategory,
          size: (draft.size || '').trim() || 'N/A',
          description: (draft.description || '').trim(),
          groupDescription: (editDescription || '').trim(),
          forceShowDescription: draft.forceShowDescription === true,
          familyDisplayMode: editFamilyDisplayMode,
          allowedUnits,
          imageUri: resolvedVariantImageUri,
          imageStoragePath: resolvedVariantImageStoragePath,
          // Store the Group Cover URI in all variants only if the picker is enabled
          groupCoverUri: showGroupCoverPicker ? (groupCoverImageUri || '') : '',
          groupCoverStoragePath: showGroupCoverPicker ? (variant.groupCoverStoragePath || '') : ''
        };
      });

      if (variantsToUpdate.length > 1 && StorageService.updateMaterialFamily) {
        await StorageService.updateMaterialFamily(variantsToUpdate);
      } else {
        const singleVariant = variantsToUpdate[0];
        await StorageService.updateMaterial(singleVariant.id, singleVariant);
      }

      setModalVisible(false);
      await loadCatalog();

      // Reclaim disk space if images were changed or removed
      StorageService.reclaimDiskSpace?.();

      Alert.alert('Saved', variantsToUpdate.length > 1 ? 'Catalog family updated.' : 'Catalog material updated.');
    } catch (error) {
      console.error('Error updating catalog family:', error);
      Alert.alert('Error', error.message === 'DUPLICATE_MATERIAL' ? 'Another material with this name and size already exists.' : 'Could not update this catalog item.');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!isOwner) {
      Alert.alert('Owner Required', 'Only owners can delete materials from the catalog.');
      return;
    }
    const variants = selectedVariants.length ? selectedVariants : [selectedItem].filter(Boolean);
    if (!variants.length) return;

    Alert.alert(
      selectedItem?.isFamilyGroup ? 'Permanent Delete Family' : 'Permanent Delete Material',
      selectedItem?.isFamilyGroup
        ? `This will permanently delete all ${variants.length} size variants for "${editName}" from Firebase. This cannot be undone.`
        : `This will permanently delete "${getMaterialDisplayName(variants[0])}" from Firebase. This cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete Forever',
          style: 'destructive',
          onPress: async () => {
            try {
              setSaving(true);
              for (const variant of variants) {
                await StorageService.permanentDeleteMaterial(variant.id);
              }
              setModalVisible(false);
              await loadCatalog();
              StorageService.reclaimDiskSpace?.();
              Alert.alert('Deleted', 'Catalog item has been permanently deleted from Firebase.');
            } catch (error) {
              console.error('Error deleting catalog family:', error);
              Alert.alert('Error', 'Could not delete this catalog item.');
            } finally {
              setSaving(false);
            }
          }
        }
      ]
    );
  };

  if (loading) {
    return <SafeAreaView style={[styles.container, styles.centered]} edges={['left','right','bottom']}><ActivityIndicator size="large" color="#64ffda" /></SafeAreaView>;
  }

  return (
    <SafeAreaView style={styles.container} edges={['left','right','bottom']}>
      <View style={styles.headerRow}>
        <Text style={styles.title}>CATALOG MANAGER</Text>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <TouchableOpacity style={styles.menuButton} onPress={() => setMenuModalVisible(true)}>
            <Text style={styles.menuButtonText}>Filter & Sort ⚙️</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.addButton} onPress={() => navigation.navigate('AddMaterial')}><Text style={styles.addButtonText}>+ New</Text></TouchableOpacity>
        </View>
      </View>
      <TextInput style={styles.searchBar} placeholder="Search family to edit..." placeholderTextColor="#99a" value={search} onChangeText={handleSearch} />
      <View style={styles.syncRow}>
        <Text style={styles.syncText}>{lastSyncMessage || 'Pull down to sync manager with Firebase.'}</Text>
        <TouchableOpacity style={styles.syncButton} onPress={refreshCatalogFromFirebase} disabled={refreshing}>
          <Text style={styles.syncButtonText}>{refreshing ? 'Syncing...' : 'Sync Now'}</Text>
        </TouchableOpacity>
        {isOwner ? (
          <TouchableOpacity style={styles.optimizeButton} onPress={migrateCatalogImagesToThumbnails} disabled={refreshing}>
            <Text style={styles.syncButtonText}>Optimize Images</Text>
          </TouchableOpacity>
        ) : null}
      </View>

      <View style={styles.catalogActionRow}>
        <TouchableOpacity
          style={[styles.multiSelectButton, isMultiSelectMode && styles.multiSelectButtonActive]}
          onPress={toggleMultiSelectMode}
        >
          <Text style={[styles.multiSelectButtonText, isMultiSelectMode && styles.multiSelectButtonTextActive]}>
            {isMultiSelectMode ? 'Cancel Selection' : 'Selection Mode'}
          </Text>
        </TouchableOpacity>
        {isMultiSelectMode && (
          <Text style={styles.selectedCounter}>{selectedItems.length} items selected</Text>
        )}
      </View>
      <View style={styles.paginationBar}>
        <TouchableOpacity style={[styles.pageButton, currentPage === 1 && styles.pageButtonDisabled]} onPress={() => goToPage(1)} disabled={currentPage === 1}><Text style={styles.pageButtonText}>« First</Text></TouchableOpacity>
        <TouchableOpacity style={[styles.pageButton, currentPage === 1 && styles.pageButtonDisabled]} onPress={() => goToPage(currentPage - 1)} disabled={currentPage === 1}><Text style={styles.pageButtonText}>‹ Prev</Text></TouchableOpacity>
        <Text style={styles.pageInfo}>Page {currentPage} / {totalPages} • {filtered.length} groups</Text>
        <TouchableOpacity style={[styles.pageButton, currentPage === totalPages && styles.pageButtonDisabled]} onPress={() => goToPage(currentPage + 1)} disabled={currentPage === totalPages}><Text style={styles.pageButtonText}>Next ›</Text></TouchableOpacity>
        <TouchableOpacity style={[styles.pageButton, currentPage === totalPages && styles.pageButtonDisabled]} onPress={() => goToPage(totalPages)} disabled={currentPage === totalPages}><Text style={styles.pageButtonText}>Last »</Text></TouchableOpacity>
      </View>

      <FlatList
        ref={listRef}
        data={paginatedFamilies}
        keyExtractor={(item, index) => `${item.id || item.familyKey || item.name || 'catalog'}-${index}`}
        initialNumToRender={10}
        maxToRenderPerBatch={8}
        windowSize={7}
        updateCellsBatchingPeriod={60}
        removeClippedSubviews={true}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={refreshCatalogFromFirebase}
            tintColor="#64ffda"
            colors={["#64ffda"]}
            progressBackgroundColor="#112240"
          />
        }
        contentContainerStyle={{ paddingBottom: 40 }}
        renderItem={({ item }) => {
          const displayName = item?.isFamilyGroup ? item.name : getMaterialDisplayName(item);
          const sizeSummary = item?.isFamilyGroup && item.availableSizes?.length ? `Sizes: ${item.availableSizes.join(', ')}` : '';
          const colorSummary = item?.isFamilyGroup && item.availableColors?.length ? `Colors: ${item.availableColors.length}` : '';
          const detailSummary = sizeSummary || colorSummary || (item.size && item.size !== 'N/A' ? item.size : 'Single item');

          const itemId = item.id || item.familyKey;
          const isSelected = selectedItems.some((s) => (s.id || s.familyKey) === itemId);

          return (
            <TouchableOpacity
              style={[styles.card, isSelected && styles.cardSelected]}
              onPress={() => isMultiSelectMode ? toggleItemSelection(item) : openEditModal(item)}
            >
              {isMultiSelectMode && (
                <View style={[styles.checkbox, isSelected && styles.checkboxActive]}>
                  <Text style={styles.checkboxText}>{isSelected ? '✓' : ''}</Text>
                </View>
              )}
              <TouchableOpacity onPress={() => item.imageUri ? openZoom(item.imageUri) : null}>
                <CachedCatalogImage
                  material={item}
                  style={styles.thumbnail}
                  placeholderStyle={styles.thumbnailPlaceholder}
                  placeholderTextStyle={styles.thumbnailPlaceholderText}
                />
              </TouchableOpacity>
              <View style={{ flex: 1 }}>
                <Text style={styles.itemName}>{displayName}</Text>
                <Text style={styles.itemCategory}>{item.category}</Text>
                <Text style={styles.itemUnits}>{detailSummary}</Text>
              </View>
              {!isMultiSelectMode && <Text style={styles.editIcon}>✏️</Text>}
            </TouchableOpacity>
          );
        }}
      />

      {isMultiSelectMode && (
        <View style={styles.multiSelectFooter}>
          <TouchableOpacity
            style={[styles.groupSelectedButton, selectedItems.length === 0 && styles.groupSelectedButtonDisabled]}
            onPress={() => setGroupModalVisible(true)}
            disabled={selectedItems.length === 0}
          >
            <Text style={styles.groupSelectedButtonText}>Group Selected Materials ({selectedItems.length})</Text>
          </TouchableOpacity>
        </View>
      )}

      <Modal visible={menuModalVisible} transparent animationType="slide" onRequestClose={() => setMenuModalVisible(false)}>
        <View style={styles.menuModalOverlay}>
          <View style={styles.menuModalContent}>
            <Text style={styles.menuModalTitle}>Filters & Organization</Text>

            <Text style={styles.menuSectionTitle}>1. Filter by Category</Text>
            <ScrollView horizontal={false} style={{ maxHeight: 300 }} showsVerticalScrollIndicator={false}>
              <View style={styles.menuGrid}>
                {QUICK_FILTERS.map((filterOption) => (
                  <TouchableOpacity
                    key={filterOption.id}
                    style={[styles.menuOption, activeQuickFilter === filterOption.id && styles.menuOptionActive]}
                    onPress={() => changeQuickFilter(filterOption.id)}
                  >
                    <Text style={[styles.menuOptionText, activeQuickFilter === filterOption.id && styles.menuOptionTextActive]}>
                      {filterOption.label}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </ScrollView>

            <Text style={[styles.menuSectionTitle, { marginTop: 20 }]}>2. Sort Catalog</Text>
            <TouchableOpacity style={[styles.sortOption, sortMode === 'name' && styles.sortOptionActive]} onPress={() => changeSortMode('name')}>
              <Text style={[styles.sortOptionText, sortMode === 'name' && styles.sortOptionTextActive]}>Sort by Name (A-Z)</Text>
              <Text style={styles.sortOptionHint}>Alphabetical, with sizes ordered from smallest to largest.</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.sortOption, sortMode === 'frequent' && styles.sortOptionActive]} onPress={() => changeSortMode('frequent')}>
              <Text style={[styles.sortOptionText, sortMode === 'frequent' && styles.sortOptionTextActive]}>Most Frequently Requested</Text>
              <Text style={styles.sortOptionHint}>Materials used more often appear at the top.</Text>
            </TouchableOpacity>

            <TouchableOpacity style={styles.menuCloseButton} onPress={() => setMenuModalVisible(false)}>
              <Text style={styles.menuCloseText}>Close</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <Modal visible={modalVisible} transparent animationType="fade" onRequestClose={() => setModalVisible(false)}>
        <View style={styles.modalOverlay}>
          <SafeAreaView style={styles.modalSafeArea} edges={['top','left','right','bottom']}>
            <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'} keyboardVerticalOffset={0}>
            <View style={styles.modalContent}>
              <TouchableOpacity style={styles.closeIconButton} onPress={() => setModalVisible(false)}>
                <Text style={styles.closeIconText}>✕</Text>
              </TouchableOpacity>
              <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
                <Text style={styles.modalTitle}>{selectedItem?.isFamilyGroup ? 'EDIT MATERIAL FAMILY' : 'EDIT CATALOG MATERIAL'}</Text>
                <Text style={styles.modalSubtitle}>Manage group cover and individual material details.</Text>

                <View style={styles.imageEditSection}>
                  <TouchableOpacity
                    style={[styles.checkboxRow, showGroupCoverPicker && styles.checkboxRowActive]}
                    onPress={() => setShowGroupCoverPicker(!showGroupCoverPicker)}
                  >
                    <Text style={styles.checkboxBox}>{showGroupCoverPicker ? '☑' : '☐'}</Text>
                    <Text style={[styles.familyOptionText, showGroupCoverPicker && styles.familyOptionTextActive]}>Enable Group Cover Photo</Text>
                  </TouchableOpacity>

                  {showGroupCoverPicker && (
                    <>
                      <Text style={styles.imageSectionTitle}>GROUP COVER PHOTO</Text>
                      <Text style={styles.imageSectionSub}>This photo represents the group in the main catalog list.</Text>
                      {groupCoverImageUri ? (
                        <TouchableOpacity onPress={() => openZoom(groupCoverImageUri)}>
                          <Image source={{ uri: groupCoverImageUri }} style={styles.modalImage} resizeMode="contain" />
                        </TouchableOpacity>
                      ) : <View style={styles.modalImagePlaceholder}><Text style={styles.modalImagePlaceholderText}>No Group Cover</Text></View>}
                      <View style={styles.imageButtonRow}>
                        <TouchableOpacity style={styles.imageButton} onPress={pickGroupCoverImage}><Text style={styles.imageButtonText}>📁 Replace</Text></TouchableOpacity>
                        <TouchableOpacity style={styles.imageButton} onPress={takeGroupCoverPhoto}><Text style={styles.imageButtonText}>📷 Camera</Text></TouchableOpacity>
                      </View>
                      {groupCoverImageUri ? (
                        <TouchableOpacity style={styles.removeImageButton} onPress={() => setGroupCoverImageUri('')}>
                          <Text style={styles.removeImageText}>Remove Group Cover</Text>
                        </TouchableOpacity>
                      ) : null}
                    </>
                  )}
                </View>

                <Text style={styles.inputLabel}>Family / Material Name:</Text>
                <TextInput style={styles.modalInput} value={editName} onChangeText={handleEditNameChange} />

                <TouchableOpacity
                  style={styles.changeFamilyButton}
                  onPress={() => setIsChangingFamily(!isChangingFamily)}
                >
                  <Text style={styles.changeFamilyButtonText}>
                    {isChangingFamily ? 'Hide Group Selection' : 'Change Group / Family'}
                  </Text>
                </TouchableOpacity>

                {isChangingFamily && (
                  <View style={styles.changeFamilyPanel}>
                    <View style={styles.groupTypeContainer}>
                      <TouchableOpacity
                        style={[styles.groupTypeButton, isMovingToNewGroup && styles.groupTypeButtonActive]}
                        onPress={() => setIsMovingToNewGroup(true)}
                      >
                        <Text style={[styles.groupTypeButtonText, isMovingToNewGroup && styles.groupTypeButtonTextActive]}>NEW</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={[styles.groupTypeButton, !isMovingToNewGroup && styles.groupTypeButtonActive]}
                        onPress={() => setIsMovingToNewGroup(false)}
                      >
                        <Text style={[styles.groupTypeButtonText, !isMovingToNewGroup && styles.groupTypeButtonTextActive]}>EXISTING</Text>
                      </TouchableOpacity>
                    </View>

                    {isMovingToNewGroup ? (
                      <TextInput
                        style={styles.modalInput}
                        value={targetGroupName}
                        onChangeText={(text) => {
                          setTargetGroupName(text);
                          handleEditNameChange(text);
                        }}
                        placeholder="New group name..."
                        placeholderTextColor="#777"
                      />
                    ) : (
                      <View>
                        <TextInput
                          style={styles.modalInput}
                          value={groupSearchText}
                          onChangeText={setGroupSearchText}
                          placeholder="Search group..."
                          placeholderTextColor="#777"
                        />
                        <ScrollView style={{ maxHeight: 150 }} nestedScrollEnabled>
                          {buildCatalogDisplayItems(catalog)
                            .filter(item => item.isFamilyGroup && item.name.toLowerCase().includes(groupSearchText.toLowerCase()))
                            .map(group => (
                              <TouchableOpacity
                                key={group.familyKey}
                                style={[styles.groupOption, editName === group.name && styles.groupOptionActive]}
                                onPress={() => {
                                  setTargetGroupName(group.name);
                                  handleEditNameChange(group.name);
                                }}
                              >
                                <Text style={[styles.groupOptionText, editName === group.name && styles.groupOptionTextActive]}>{group.name}</Text>
                              </TouchableOpacity>
                            ))}
                        </ScrollView>
                      </View>
                    )}
                  </View>
                )}

                <Text style={styles.inputLabel}>Registered Family Items:</Text>
                <View style={styles.variantListCard}>
                  {variantDrafts.map((draft) => (
                    <TouchableOpacity key={draft.id} style={styles.variantCardRow} onPress={() => openVariantEditor(draft)}>
                      {(draft.imageUri || draft.original?.imageUri) ? (
                        <Image
                          source={{ uri: draft.imageUri || draft.original.imageUri }}
                          style={styles.variantThumbnail}
                          resizeMode="contain"
                        />
                      ) : null}
                      <View style={{ flex: 1 }}>
                        <Text style={styles.variantCardTitle}>{draft.name || draft.original?.name || 'Unnamed Material'}</Text>
                        <Text style={styles.variantCardLine}>Size / Variant: {draft.size || 'N/A'}</Text>
                        <Text style={styles.variantCardDescription} numberOfLines={2}>{draft.description || 'No material description'}</Text>
                      </View>
                      <TouchableOpacity style={styles.variantDeleteButton} onPress={() => deleteSingleVariant(draft.id)} disabled={saving}>
                        <Text style={styles.variantDeleteText}>✕</Text>
                      </TouchableOpacity>
                    </TouchableOpacity>
                  ))}
                </View>
                <Text style={styles.helperText}>Tap any material in this family to open a focused editor for name, size, and description.</Text>

                <Text style={styles.inputLabel}>Family / Group Catalog Description:</Text>
                <TextInput style={[styles.modalInput, styles.descriptionInput]} value={editDescription} onChangeText={setEditDescription} multiline placeholder="Optional description for this family/group only" placeholderTextColor="#777" />
                <Text style={styles.helperText}>This group description will not overwrite the personal description of each material. Tap a material above to edit its own description.</Text>

                <Text style={styles.inputLabel}>Family Display Layout:</Text>
                <View style={styles.grid}>
                  <TouchableOpacity
                    style={[styles.selector, editFamilyDisplayMode === 'grid' && styles.selectorActive]}
                    onPress={() => setEditFamilyDisplayMode('grid')}
                  >
                    <Text style={[styles.selectorText, editFamilyDisplayMode === 'grid' && styles.selectorTextActive]}>SQUARE BUTTONS</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.selector, editFamilyDisplayMode === 'list' && styles.selectorActive]}
                    onPress={() => setEditFamilyDisplayMode('list')}
                  >
                    <Text style={[styles.selectorText, editFamilyDisplayMode === 'list' && styles.selectorTextActive]}>LIST WITH PHOTO</Text>
                  </TouchableOpacity>
                </View>
                <Text style={styles.helperText}>Use square buttons for sizes/colors, or list with photo for materials that need name, size, image, and description.</Text>

                <Text style={styles.inputLabel}>Category:</Text>
                <View style={styles.grid}>{categories.map((c) => <TouchableOpacity key={String(c)} style={[styles.selector, editCategory === c && styles.selectorActive]} onPress={() => { setEditCategory(c); setAllowedUnits(getDefaultAllowedUnitsByCategory(c)); }}><Text style={[styles.selectorText, editCategory === c && styles.selectorTextActive]}>{String(c).toUpperCase()}</Text></TouchableOpacity>)}</View>

                <Text style={styles.inputLabel}>Units this family should show:</Text>
                <View style={styles.grid}>{unitOptions.map((u) => <TouchableOpacity key={u} style={[styles.selector, allowedUnits.includes(u) && styles.selectorActive]} onPress={() => toggleAllowedUnit(u)}><Text style={[styles.selectorText, allowedUnits.includes(u) && styles.selectorTextActive]}>{u}</Text></TouchableOpacity>)}</View>

                {isOwner && (
                  <TouchableOpacity style={styles.deleteButton} onPress={handleDelete} disabled={saving}>
                    <Text style={styles.deleteButtonText}>{selectedItem?.isFamilyGroup ? '🗑 Permanently Delete Family' : '🗑 Permanently Delete Material'}</Text>
                  </TouchableOpacity>
                )}

                <View style={styles.modalActions}>
                  <TouchableOpacity style={[styles.modalBtn, { backgroundColor: '#8892b0' }]} onPress={() => setModalVisible(false)} disabled={saving}><Text style={styles.btnText}>Cancel</Text></TouchableOpacity>
                  <TouchableOpacity style={[styles.modalBtn, { backgroundColor: '#0275d8' }]} onPress={saveEdits} disabled={saving}>{saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.btnText}>Save</Text>}</TouchableOpacity>
                </View>
              </ScrollView>
            </View>
            </KeyboardAvoidingView>
          </SafeAreaView>
        </View>
      </Modal>

      <Modal visible={variantEditorVisible} transparent animationType="slide" onRequestClose={() => setVariantEditorVisible(false)}>
        <View style={styles.modalOverlay}>
          <SafeAreaView style={styles.modalSafeArea} edges={['top','left','right','bottom']}>
            <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'} keyboardVerticalOffset={0}>
              <View style={styles.variantEditorModal}>
                <TouchableOpacity style={styles.closeIconButton} onPress={() => setVariantEditorVisible(false)}>
                  <Text style={styles.closeIconText}>✕</Text>
                </TouchableOpacity>
                <ScrollView
                  showsVerticalScrollIndicator={false}
                  keyboardShouldPersistTaps="handled"
                  keyboardDismissMode="interactive"
                  contentContainerStyle={styles.variantEditorScrollContent}
                >
                  <Text style={styles.modalTitle}>EDIT MATERIAL DETAILS</Text>

                  <TouchableOpacity
                    style={[styles.checkboxRow, showIndividualImagePicker && styles.checkboxRowActive]}
                    onPress={() => setShowIndividualImagePicker(!showIndividualImagePicker)}
                  >
                    <Text style={styles.checkboxBox}>{showIndividualImagePicker ? '☑' : '☐'}</Text>
                    <Text style={[styles.familyOptionText, showIndividualImagePicker && styles.familyOptionTextActive]}>Enable Individual Photo</Text>
                  </TouchableOpacity>

                  {showIndividualImagePicker && (
                    <>
                      <Text style={styles.imageSectionTitle}>INDIVIDUAL PHOTO</Text>
                      <Text style={styles.imageSectionSub}>This photo only shows up when choosing this specific material.</Text>

                      {activeVariantImageUri ? (
                        <TouchableOpacity onPress={() => openZoom(activeVariantImageUri)}>
                          <Image source={{ uri: activeVariantImageUri }} style={styles.modalImage} resizeMode="contain" />
                        </TouchableOpacity>
                      ) : <View style={styles.modalImagePlaceholder}><Text style={styles.modalImagePlaceholderText}>No Individual Photo</Text></View>}
                      <View style={styles.imageButtonRow}>
                        <TouchableOpacity style={styles.imageButton} onPress={pickVariantImage}><Text style={styles.imageButtonText}>📁 Replace</Text></TouchableOpacity>
                        <TouchableOpacity style={styles.imageButton} onPress={takeVariantPhoto}><Text style={styles.imageButtonText}>📷 Camera</Text></TouchableOpacity>
                      </View>
                      {activeVariantImageUri ? <TouchableOpacity style={styles.removeImageButton} onPress={() => setActiveVariantImageUri('')}><Text style={styles.removeImageText}>Remove Photo</Text></TouchableOpacity> : null}
                    </>
                  )}

                  <Text style={styles.inputLabel}>Material Name:</Text>
                  <TextInput style={styles.modalInput} value={activeVariantName} onChangeText={setActiveVariantName} placeholder="Material name" placeholderTextColor="#777" />
                  <Text style={styles.inputLabel}>Size / Variant:</Text>
                  <TextInput style={styles.modalInput} value={activeVariantSize} onChangeText={setActiveVariantSize} placeholder="e.g.: 3/4, #12 Black, 5/16" placeholderTextColor="#777" />
                  <Text style={styles.inputLabel}>Description:</Text>
                  <TextInput style={[styles.modalInput, styles.descriptionInput]} value={activeVariantDescription} onChangeText={setActiveVariantDescription} multiline placeholder="Description for this material" placeholderTextColor="#777" />
                  <TouchableOpacity style={styles.hardDeleteConfirmRow} onPress={() => setActiveVariantForceShowDescription((v) => !v)}>
                    <Text style={[styles.hardDeleteCheckbox, { color: '#0a192f' }]}>{activeVariantForceShowDescription ? '☑' : '☐'}</Text>
                    <Text style={[styles.hardDeleteWarning, { color: '#0a192f' }]}>Always show description during selection</Text>
                  </TouchableOpacity>
                  <View style={styles.modalActions}>
                    <TouchableOpacity style={[styles.modalBtn, { backgroundColor: '#8892b0' }]} onPress={() => setVariantEditorVisible(false)}><Text style={styles.btnText}>Cancel</Text></TouchableOpacity>
                    <TouchableOpacity style={[styles.modalBtn, { backgroundColor: '#0275d8' }]} onPress={saveVariantEditor}><Text style={styles.btnText}>Save Item</Text></TouchableOpacity>
                  </View>
                </ScrollView>
              </View>
            </KeyboardAvoidingView>
          </SafeAreaView>
        </View>
      </Modal>

      <Modal visible={groupModalVisible} transparent animationType="slide" onRequestClose={() => setGroupModalVisible(false)}>
        <View style={styles.modalOverlay}>
          <SafeAreaView style={styles.modalSafeArea} edges={['top','left','right','bottom']}>
            <View style={styles.modalContent}>
              <TouchableOpacity style={styles.closeIconButton} onPress={() => setGroupModalVisible(false)}>
                <Text style={styles.closeIconText}>✕</Text>
              </TouchableOpacity>
              <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
                <Text style={styles.modalTitle}>GROUP MATERIALS</Text>
                <Text style={styles.modalSubtitle}>Move the {selectedItems.length} selected items to a new or existing group.</Text>

                <View style={styles.groupTypeContainer}>
                  <TouchableOpacity
                    style={[styles.groupTypeButton, isMovingToNewGroup && styles.groupTypeButtonActive]}
                    onPress={() => setIsMovingToNewGroup(true)}
                  >
                    <Text style={[styles.groupTypeButtonText, isMovingToNewGroup && styles.groupTypeButtonTextActive]}>NEW GROUP</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.groupTypeButton, !isMovingToNewGroup && styles.groupTypeButtonActive]}
                    onPress={() => setIsMovingToNewGroup(false)}
                  >
                    <Text style={[styles.groupTypeButtonText, !isMovingToNewGroup && styles.groupTypeButtonTextActive]}>EXISTING GROUP</Text>
                  </TouchableOpacity>
                </View>

                {isMovingToNewGroup ? (
                  <View style={{ marginTop: 10 }}>
                    <Text style={styles.inputLabel}>New Group Name:</Text>
                    <TextInput
                      style={styles.modalInput}
                      value={targetGroupName}
                      onChangeText={setTargetGroupName}
                      placeholder="e.g.: Drill Bit, EMT Pipe, UTP Cable"
                      placeholderTextColor="#777"
                    />
                  </View>
                ) : (
                  <View style={{ marginTop: 10 }}>
                    <Text style={styles.inputLabel}>Search Existing Group:</Text>
                    <TextInput
                      style={styles.modalInput}
                      value={groupSearchText}
                      onChangeText={setGroupSearchText}
                      placeholder="Search group name..."
                      placeholderTextColor="#777"
                    />
                    <ScrollView style={{ maxHeight: 200 }} nestedScrollEnabled>
                      {buildCatalogDisplayItems(catalog)
                        .filter(item => item.isFamilyGroup && item.name.toLowerCase().includes(groupSearchText.toLowerCase()))
                        .map(group => (
                          <TouchableOpacity
                            key={group.familyKey}
                            style={[styles.groupOption, targetGroupName === group.name && styles.groupOptionActive]}
                            onPress={() => setTargetGroupName(group.name)}
                          >
                            <Text style={[styles.groupOptionText, targetGroupName === group.name && styles.groupOptionTextActive]}>{group.name}</Text>
                            <Text style={styles.groupOptionSubText}>{group.category} • {group.variants.length} items</Text>
                          </TouchableOpacity>
                        ))}
                    </ScrollView>
                  </View>
                )}

                <View style={styles.modalActions}>
                  <TouchableOpacity style={[styles.modalBtn, { backgroundColor: '#8892b0' }]} onPress={() => setGroupModalVisible(false)} disabled={saving}>
                    <Text style={styles.btnText}>Cancel</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={[styles.modalBtn, { backgroundColor: '#0275d8' }]} onPress={handleApplyGrouping} disabled={saving}>
                    {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.btnText}>Apply Grouping</Text>}
                  </TouchableOpacity>
                </View>
              </ScrollView>
            </View>
          </SafeAreaView>
        </View>
      </Modal>

      <ImageZoomModal
        visible={zoomVisible}
        imageUri={zoomImageUri}
        onClose={() => setZoomVisible(false)}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a192f', padding: 15 },
  centered: { justifyContent: 'center', alignItems: 'center' },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  title: { color: '#64ffda', fontWeight: '900', fontSize: 16 },
  addButton: { backgroundColor: '#0275d8', paddingVertical: 10, paddingHorizontal: 14, borderRadius: 8 },
  addButtonText: { color: '#fff', fontWeight: 'bold' },
  menuButton: { backgroundColor: '#112240', borderWidth: 1, borderColor: '#64ffda', paddingHorizontal: 10, paddingVertical: 10, borderRadius: 8, justifyContent: 'center', alignItems: 'center' },
  menuButtonText: { color: '#64ffda', fontWeight: 'bold', fontSize: 11 },
  menuModalOverlay: { flex: 1, backgroundColor: 'rgba(2, 12, 27, 0.85)', justifyContent: 'center', alignItems: 'center', padding: 20 },
  menuModalContent: { width: '100%', backgroundColor: '#ccd6f6', borderRadius: 20, padding: 20, maxHeight: '85%' },
  menuModalTitle: { fontSize: 20, fontWeight: '900', color: '#0a192f', textAlign: 'center', marginBottom: 15 },
  menuSectionTitle: { color: '#0a192f', fontSize: 14, fontWeight: '900', marginBottom: 10, textTransform: 'uppercase', letterSpacing: 0.5 },
  menuGrid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' },
  menuOption: { backgroundColor: '#f1f5f9', width: '48%', padding: 12, borderRadius: 10, marginBottom: 8, borderWidth: 1, borderColor: '#cbd5e1', alignItems: 'center' },
  menuOptionActive: { backgroundColor: '#0275d8', borderColor: '#0275d8' },
  menuOptionText: { color: '#334155', fontWeight: '800', fontSize: 13 },
  menuOptionTextActive: { color: '#fff' },
  sortOption: { backgroundColor: '#f1f5f9', borderWidth: 1, borderColor: '#cbd5e1', borderRadius: 12, padding: 14, marginBottom: 10 },
  sortOptionActive: { backgroundColor: '#dbeafe', borderColor: '#0275d8' },
  sortOptionText: { color: '#0f172a', fontWeight: '900', fontSize: 14 },
  sortOptionTextActive: { color: '#0275d8' },
  sortOptionHint: { color: '#64748b', fontSize: 11, marginTop: 4 },
  menuCloseButton: { backgroundColor: '#0a192f', borderRadius: 12, padding: 14, alignItems: 'center', marginTop: 10 },
  menuCloseText: { color: '#fff', fontWeight: '900', fontSize: 15 },
  searchBar: { backgroundColor: '#172a45', padding: 13, borderRadius: 10, marginBottom: 15, color: '#e6f1ff', borderWidth: 1, borderColor: '#303c55' },
  card: { backgroundColor: '#112240', padding: 14, borderRadius: 10, marginBottom: 10, flexDirection: 'row', alignItems: 'center', borderLeftWidth: 4, borderLeftColor: '#0275d8' },
  thumbnail: { width: 64, height: 64, borderRadius: 10, marginRight: 12, backgroundColor: '#172a45' },
  thumbnailPlaceholder: { width: 64, height: 64, borderRadius: 10, marginRight: 12, backgroundColor: '#172a45', justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: '#233554' },
  thumbnailPlaceholderText: { color: '#8892b0', fontSize: 9, fontWeight: 'bold' },
  itemName: { fontSize: 15, fontWeight: 'bold', color: '#ccd6f6' },
  itemCategory: { fontSize: 12, color: '#8892b0', marginTop: 3 },
  itemUnits: { fontSize: 11, color: '#64ffda', marginTop: 3 },
  editIcon: { fontSize: 20 },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(2, 12, 27, 0.8)' },
  modalSafeArea: { flex: 1, justifyContent: 'center', paddingHorizontal: 12 },
  modalContent: { backgroundColor: '#ccd6f6', maxHeight: '92%', padding: 20, borderRadius: 15 },
  modalTitle: { fontSize: 15, fontWeight: 'bold', color: '#0a192f', textAlign: 'center' },
  modalSubtitle: { fontSize: 11, color: '#334155', textAlign: 'center', marginTop: 5 },
  modalImage: { width: 170, height: 170, borderRadius: 14, alignSelf: 'center', marginVertical: 12, backgroundColor: '#fff' },
  modalImagePlaceholder: { width: 170, height: 170, borderRadius: 14, alignSelf: 'center', marginVertical: 12, backgroundColor: '#fff', justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: '#aaa', borderStyle: 'dashed' },
  modalImagePlaceholderText: { color: '#555', fontSize: 11, fontWeight: 'bold' },
  imageButtonRow: { flexDirection: 'row', justifyContent: 'space-between' },
  imageButton: { backgroundColor: '#172a45', padding: 10, borderRadius: 8, width: '48%', alignItems: 'center' },
  imageButtonText: { color: '#e6f1ff', fontWeight: 'bold', fontSize: 12 },
  removeImageButton: { marginTop: 10, alignItems: 'center' },
  removeImageText: { color: '#e74c3c', fontWeight: 'bold', fontSize: 12 },
  inputLabel: { fontWeight: 'bold', color: '#0a192f', marginTop: 10, fontSize: 12 },
  modalInput: { borderBottomWidth: 1.5, borderColor: '#0a192f55', padding: 6, marginBottom: 10, color: '#0a192f', fontSize: 14 },
  descriptionInput: { minHeight: 78, textAlignVertical: 'top' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', marginTop: 8 },
  selector: { backgroundColor: '#fff', padding: 8, borderRadius: 6, marginBottom: 6, width: '48%', alignItems: 'center', borderWidth: 1, borderColor: '#ccc' },
  sizeGrid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', marginTop: 8, marginBottom: 4 },
  sizeSelector: { backgroundColor: '#fff', padding: 8, borderRadius: 6, marginBottom: 6, width: '31%', alignItems: 'center', borderWidth: 1, borderColor: '#ccc' },
  selectorActive: { backgroundColor: '#0275d8', borderColor: '#0275d8' },
  selectorText: { fontSize: 11, color: '#333', fontWeight: 'bold' },
  selectorTextActive: { color: '#fff' },
  helperText: { color: '#334155', fontSize: 11, marginBottom: 4 },
  variantListCard: { backgroundColor: '#e2e8f0', borderRadius: 12, padding: 10, marginTop: 8, marginBottom: 8 },
  variantCardRow: { backgroundColor: '#fff', borderRadius: 10, padding: 12, marginBottom: 8, flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: '#cbd5e1' },
  variantCardTitle: { color: '#0a192f', fontWeight: '900', fontSize: 14 },
  variantCardLine: { color: '#0275d8', fontWeight: '700', marginTop: 4, fontSize: 12 },
  variantCardDescription: { color: '#475569', marginTop: 4, fontSize: 11 },
  variantEditorModal: {
    backgroundColor: '#ccd6f6',
    borderRadius: 15,
    maxHeight: '92%',
    marginTop: 'auto',
    marginBottom: 'auto',
    paddingTop: 20,
    paddingHorizontal: 20,
    paddingBottom: 0,
  },
  variantEditorScrollContent: { paddingBottom: 34 },
  deleteButton: { marginTop: 20, padding: 12, borderRadius: 8, borderWidth: 1, borderColor: '#e74c3c', alignItems: 'center', backgroundColor: '#fff' },
  deleteButtonText: { color: '#e74c3c', fontWeight: 'bold', fontSize: 13 },
  hardDeleteBox: { marginTop: 12, padding: 12, borderRadius: 10, backgroundColor: '#fee2e2', borderWidth: 1, borderColor: '#ef4444' },
  hardDeleteConfirmRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 },
  hardDeleteCheckbox: { fontSize: 18, color: '#991b1b', fontWeight: '900' },
  hardDeleteWarning: { flex: 1, color: '#7f1d1d', fontWeight: '800', fontSize: 12 },
  hardDeleteButton: { backgroundColor: '#dc2626', borderRadius: 8, padding: 12, alignItems: 'center' },
  hardDeleteButtonDisabled: { opacity: 0.35 },
  hardDeleteButtonText: { color: '#fff', fontWeight: '900', fontSize: 12 },
  modalActions: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 15 },
  modalBtn: { padding: 12, borderRadius: 8, width: '48%', alignItems: 'center' },
  btnText: { color: '#fff', fontWeight: 'bold' },
  closeIconButton: { position: 'absolute', top: 10, right: 10, width: 34, height: 34, borderRadius: 17, backgroundColor: '#0a192f', alignItems: 'center', justifyContent: 'center', zIndex: 10 },
  closeIconText: { color: '#fff', fontWeight: '900', fontSize: 16 },


  syncRow: {
    marginHorizontal: 14,
    marginBottom: 10,
    padding: 10,
    borderRadius: 12,
    backgroundColor: '#112240',
    borderWidth: 1,
    borderColor: '#233554',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10
  },
  syncText: {
    flex: 1,
    color: '#a8b2d1',
    fontSize: 12
  },
  syncButton: {
    backgroundColor: '#0ea5e9',
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 10
  },
  syncButtonText: {
    color: '#ffffff',
    fontWeight: '700',
    fontSize: 12
  },

  paginationBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: 6,
    paddingHorizontal: 12,
    paddingBottom: 8
  },
  pageButton: {
    backgroundColor: '#112240',
    borderColor: '#64ffda',
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 10
  },
  pageButtonDisabled: { opacity: 0.35 },
  pageButtonText: { color: '#64ffda', fontWeight: '700', fontSize: 12 },
  pageInfo: { color: '#ccd6f6', fontWeight: '700', fontSize: 12, paddingHorizontal: 4 },

  catalogActionRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 14,
    marginBottom: 10
  },
  multiSelectButton: {
    backgroundColor: '#112240',
    borderWidth: 1,
    borderColor: '#233554',
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8
  },
  multiSelectButtonActive: {
    borderColor: '#64ffda',
    backgroundColor: '#0d2b4f'
  },
  multiSelectButtonText: {
    color: '#ccd6f6',
    fontSize: 12,
    fontWeight: 'bold'
  },
  multiSelectButtonTextActive: {
    color: '#64ffda'
  },
  selectedCounter: {
    color: '#64ffda',
    fontWeight: 'bold',
    fontSize: 12
  },
  cardSelected: {
    borderColor: '#64ffda',
    borderWidth: 1,
    backgroundColor: '#17345a'
  },
  checkbox: {
    width: 24,
    height: 24,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#64ffda',
    marginRight: 10,
    justifyContent: 'center',
    alignItems: 'center'
  },
  checkboxActive: {
    backgroundColor: '#0275d8',
    borderColor: '#64ffda'
  },
  checkboxText: {
    color: '#fff',
    fontWeight: 'bold',
    fontSize: 14
  },
  multiSelectFooter: {
    position: 'absolute',
    left: 15,
    right: 15,
    bottom: 20,
    backgroundColor: 'transparent'
  },
  groupSelectedButton: {
    backgroundColor: '#0275d8',
    padding: 15,
    borderRadius: 10,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#64ffda',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
    elevation: 5
  },
  groupSelectedButtonDisabled: {
    backgroundColor: '#233554',
    borderColor: '#33445f'
  },
  groupSelectedButtonText: {
    color: '#fff',
    fontWeight: 'bold',
    textTransform: 'uppercase'
  },
  groupTypeContainer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 10,
    gap: 10
  },
  groupTypeButton: {
    flex: 1,
    backgroundColor: '#e2e8f0',
    padding: 10,
    borderRadius: 8,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#cbd5e1'
  },
  groupTypeButtonActive: {
    backgroundColor: '#0275d8',
    borderColor: '#0275d8'
  },
  groupTypeButtonText: {
    color: '#475569',
    fontWeight: 'bold',
    fontSize: 12
  },
  groupTypeButtonTextActive: {
    color: '#fff'
  },
  groupOption: {
    backgroundColor: '#fff',
    padding: 12,
    borderRadius: 8,
    marginBottom: 6,
    borderWidth: 1,
    borderColor: '#cbd5e1'
  },
  groupOptionActive: {
    borderColor: '#0275d8',
    backgroundColor: '#eff6ff'
  },
  groupOptionText: {
    color: '#0a192f',
    fontWeight: 'bold',
    fontSize: 14
  },
  groupOptionTextActive: {
    color: '#0275d8'
  },
  groupOptionSubText: {
    color: '#64748b',
    fontSize: 11,
    marginTop: 2
  },
  changeFamilyButton: {
    backgroundColor: '#f1f5f9',
    padding: 8,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#cbd5e1',
    alignSelf: 'flex-start',
    marginTop: 5,
    marginBottom: 10
  },
  changeFamilyButtonText: {
    color: '#475569',
    fontSize: 11,
    fontWeight: 'bold'
  },
  changeFamilyPanel: {
    backgroundColor: '#e2e8f0',
    padding: 10,
    borderRadius: 10,
    marginBottom: 15,
    borderWidth: 1,
    borderColor: '#cbd5e1'
  },
  zoomCloseButton: {
    position: 'absolute',
    top: 50,
    right: 20,
    zIndex: 100,
    backgroundColor: 'rgba(0,0,0,0.5)',
    padding: 10,
    borderRadius: 8
  },
  zoomCloseText: {
    color: '#fff',
    fontWeight: 'bold'
  },
  zoomInstruction: {
    position: 'absolute',
    bottom: 50,
    width: '100%',
    alignItems: 'center'
  },
  zoomInstructionText: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: 12
  },
  variantThumbnail: {
    width: 40,
    height: 40,
    borderRadius: 6,
    marginRight: 10,
    backgroundColor: '#fff'
  },
  imageEditSection: {
    backgroundColor: '#fff',
    padding: 15,
    borderRadius: 12,
    marginBottom: 20,
    borderWidth: 1,
    borderColor: '#cbd5e1'
  },
  imageSectionTitle: {
    color: '#075bc7',
    fontSize: 12,
    fontWeight: '900',
    textAlign: 'center'
  },
  imageSectionSub: {
    color: '#64748b',
    fontSize: 10,
    textAlign: 'center',
    marginBottom: 10
  },
  checkboxRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: '#fff',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#cbd5e1',
    padding: 10,
    marginBottom: 8
  },
  checkboxRowActive: {
    backgroundColor: '#eff6ff',
    borderColor: '#0275d8'
  },
  checkboxBox: {
    color: '#0275d8',
    fontSize: 18,
    fontWeight: '900'
  },
  familyOptionText: {
    color: '#0a192f',
    fontWeight: '800',
    fontSize: 13
  },
  familyOptionTextActive: {
    color: '#0275d8'
  }
});

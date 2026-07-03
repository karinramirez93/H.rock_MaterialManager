/**
 * CatalogScreen
 * -------------
 * Clean catalog view used only to search for materials and add them to the
 * Material Quantity Sheet. Editing controls are intentionally hidden here so
 * the user can focus on selecting materials without visual clutter.
 *
 * This version supports two ways to add materials:
 * 1. Single selection: tap one material, choose quantity/unit, and add it.
 * 2. Multiple selection: activate selection mode, check several materials,
 *    choose one quantity/unit, and add every selected material at the same time.
 *
 * The gear button opens CatalogManagerScreen when the user needs to maintain
 * the catalog. Photos and descriptions are displayed for recognition, but only
 * the required material data is sent to the draft list.
 */
import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { StyleSheet, Text, View, FlatList, TextInput, TouchableOpacity, Modal, ActivityIndicator, Image, ScrollView, BackHandler, Alert, RefreshControl, Dimensions } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { StorageService } from '../database/storage';
import { useFocusEffect } from '@react-navigation/native';
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
    <Modal visible={visible} transparent animationType="fade">
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

const getMaterialDisplayName = (material) => {
  const sizeText = material?.size && material.size !== 'N/A' ? ` ${material.size}` : '';
  return `${material?.name || 'Unnamed Material'}${sizeText}`;
};

// Converts a trade-size string into a numeric inch value so sizes always sort
// by real measurement instead of alphabetical text order.
// Supported examples:
// - 1/2"    -> 0.5
// - 3/4"    -> 0.75
// - 1"      -> 1
// - 1 1/8"  -> 1.125
// - 1 1/4"  -> 1.25
// - 2"      -> 2
// The parser is not limited to the size buttons. If a future Firebase record
// uses a valid size like 5", 6", or 1 1/8", it will still be sorted correctly.
const convertSizeToNumber = (size) => {
  if (!size || size === 'N/A') return Number.MAX_SAFE_INTEGER;

  const cleanSize = String(size)
    .replace(/inches|inch|in\.?/gi, '')
    .replace(/”|“/g, '"')
    .replace(/"/g, '')
    .trim()
    .replace(/\s+/g, ' ');

  // Matches whole numbers with optional fractions, such as 1, 1 1/8, or 2 3/4.
  const mixedNumberMatch = cleanSize.match(/^(\d+)(?:\s+(\d+)\/(\d+))?$/);
  if (mixedNumberMatch) {
    const wholeNumber = Number(mixedNumberMatch[1]);
    const numerator = mixedNumberMatch[2] ? Number(mixedNumberMatch[2]) : 0;
    const denominator = mixedNumberMatch[3] ? Number(mixedNumberMatch[3]) : 1;
    return wholeNumber + (denominator ? numerator / denominator : 0);
  }

  // Matches pure fractions, such as 1/2 or 3/4.
  const fractionMatch = cleanSize.match(/^(\d+)\/(\d+)$/);
  if (fractionMatch) {
    const numerator = Number(fractionMatch[1]);
    const denominator = Number(fractionMatch[2]);
    return denominator ? numerator / denominator : Number.MAX_SAFE_INTEGER;
  }

  const decimalValue = Number(cleanSize);
  return Number.isFinite(decimalValue) ? decimalValue : Number.MAX_SAFE_INTEGER;
};

// Reads size from the official size field first, then falls back to a trailing
// size in the material name. This protects older Firebase records that may
// still have the size typed into the name instead of stored in `size`.
const getSortableSizeValue = (material) => {
  if (material?.size && material.size !== 'N/A') return convertSizeToNumber(material.size);

  const displayName = getMaterialDisplayName(material);
  const sizeMatch = displayName.match(/(?:^|\s)((?:\d+\s+)?\d+\/\d+|\d+(?:\.\d+)?)"?\s*$/);
  return sizeMatch ? convertSizeToNumber(sizeMatch[1]) : Number.MAX_SAFE_INTEGER;
};

// Removes a trailing trade size from older material names before sorting.
// Example: "EMT Coupling 1/2" becomes "EMT Coupling" for alphabetic grouping.
const getSortableBaseName = (material) => {
  return (material?.name || getMaterialDisplayName(material) || 'Unnamed Material')
    .replace(/\s+((?:\d+\s+)?\d+\/\d+|\d+(?:\.\d+)?)"?\s*$/, '')
    .trim()
    .toLowerCase();
};


// Converts the full searchable material record into a single lower-case string.
// The search system uses this text for normal keyword searches and for matching
// future catalog records that may be added later from Firebase.
const getSearchableMaterialText = (material) => (
  [
    getMaterialDisplayName(material),
    material?.name,
    material?.familyName,
    material?.category,
    material?.size,
    material?.description,
    ...(Array.isArray(material?.keywords) ? material.keywords : [])
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
);

// Finds a trade size written in the search box and converts it to the same
// numeric value used by the sorter. This lets searches like "EMT 3/4",
// "conduit 3/4", "Emt 1 1/8", or "pipe 2" filter by actual inch size.
const extractSearchSize = (searchText) => {
  const normalizedText = String(searchText || '')
    .replace(/”|“/g, '"')
    .replace(/\s+/g, ' ')
    .trim();

  const sizePattern = /(?:^|\s)((?:\d+\s+)?\d+\/\d+|\d+(?:\.\d+)?)(?:\s*(?:"|inches|inch|in\.?))?(?=\s|$)/i;
  const match = normalizedText.match(sizePattern);

  if (!match) {
    return { sizeNumber: null, sizeText: '', searchTextWithoutSize: normalizedText };
  }

  const sizeText = match[1];
  const sizeNumber = convertSizeToNumber(sizeText);
  const searchTextWithoutSize = normalizedText
    .replace(match[0], ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return {
    sizeNumber: Number.isFinite(sizeNumber) ? sizeNumber : null,
    sizeText,
    searchTextWithoutSize
  };
};

// Compares sizes as numbers instead of text, using a tiny tolerance so decimals
// and fractions can match safely. Example: 3/4 and 0.75 are considered equal.
const materialMatchesSearchSize = (material, searchSizeNumber) => {
  if (searchSizeNumber === null || searchSizeNumber === undefined) return true;
  const materialSizeNumber = getSortableSizeValue(material);
  return Math.abs(materialSizeNumber - searchSizeNumber) < 0.0001;
};

// A broad conduit-system search is different from a very specific part search.
// Example: searching "EMT 3/4" should show EMT 3/4 plus generic 3/4 fittings
// such as bushings, caps, nipples, straps, and clamps. Searching "conduit 3/4"
// is more general and can show the full 3/4 conduit/fitting trade-size group.
const getConduitSearchMode = (remainingSearchText) => {
  const normalizedText = String(remainingSearchText || '').toLowerCase();

  if (/\bemt\b/.test(normalizedText)) return 'emt';
  if (/\b(rigid|ridgid)\b/.test(normalizedText)) return 'rigid';
  if (/\b(sealtite|seal tight|liquid tight)\b/.test(normalizedText)) return 'sealtite';
  if (/\b(conduit|pipe|raceway|tube)\b/.test(normalizedText)) return 'general';

  return null;
};

// Identifies records that belong to the conduit / fitting trade-size system.
// This makes future 1/2", 3/4", 1", etc. materials work automatically as long
// as they are saved with a size and a conduit-related category or keyword.
const isConduitSystemMaterial = (material, conduitSearchMode = 'general') => {
  const category = String(material?.category || '').toLowerCase();
  const searchableText = getSearchableMaterialText(material);
  const conduitCategories = ['conduits', 'connectors', 'fittings', 'others'];
  const isSizedTradeMaterial = material?.size && material.size !== 'N/A';

  if (!isSizedTradeMaterial) return false;

  const isGenericFitting = (
    ['fittings', 'others'].includes(category) &&
    /\b(bushing|cap|nipple|strap|clamp|fitting|lb|ll|lr|conduit body)\b/.test(searchableText)
  );

  if (conduitSearchMode === 'emt') {
    return /\bemt\b/.test(searchableText) || isGenericFitting;
  }

  if (conduitSearchMode === 'rigid') {
    return /\b(rigid|ridgid)\b/.test(searchableText) || isGenericFitting;
  }

  if (conduitSearchMode === 'sealtite') {
    return /\b(sealtite|seal tight|liquid tight)\b/.test(searchableText);
  }

  return (
    conduitCategories.includes(category) ||
    /\b(conduit|pipe|raceway|emt|rigid|ridgid|sealtite|seal tight|bushing|coupling|connector|cap|nipple|strap|clamp|fitting|lb|ll|lr)\b/.test(searchableText)
  );
};

// Normalizes a keyword search into independent words. All words must be found
// for a normal search, which makes queries like "THHN # 12" or "coupling 3/4"
// more precise than a simple full-string includes check.
const getSearchTerms = (searchText) => String(searchText || '')
  .toLowerCase()
  .replace(/[^a-z0-9#]+/g, ' ')
  .split(' ')
  .map((term) => term.trim())
  .filter(Boolean);

// Checks whether a material matches all remaining non-size search words.
const materialMatchesAllSearchTerms = (material, searchTerms) => {
  if (searchTerms.length === 0) return true;
  const searchableText = getSearchableMaterialText(material).replace(/[^a-z0-9#]+/g, ' ');
  return searchTerms.every((term) => searchableText.includes(term));
};

// Keeps the general catalog alphabetized by material family, then sorts every
// same-name family by real inch size in ascending order.
// Result example for EMT Conduit: 1/2", 3/4", 1", 1 1/8", 1 1/4", 1 1/2", 2"...
const sortCatalogByNameAndSize = (items) => {
  return [...items].sort((a, b) => {
    const baseNameComparison = getSortableBaseName(a).localeCompare(getSortableBaseName(b));
    if (baseNameComparison !== 0) return baseNameComparison;

    const sizeComparison = getSortableSizeValue(a) - getSortableSizeValue(b);
    if (sizeComparison !== 0) return sizeComparison;

    return getMaterialDisplayName(a).localeCompare(getMaterialDisplayName(b));
  });
};

// Sorts a list using the current catalog sort mode.
// - name: default alphabetical order, with same-name sizes sorted by real inch value.
// - frequent: most requested materials first, then alphabetical/size as a tie breaker.
const sortCatalogForDisplay = (items, sortMode = 'name') => {
  const nameSortedItems = sortCatalogByNameAndSize(items);

  if (sortMode !== 'frequent') {
    return nameSortedItems;
  }

  return [...nameSortedItems].sort((a, b) => {
    const requestCountComparison = Number(b.requestCount || 0) - Number(a.requestCount || 0);
    if (requestCountComparison !== 0) return requestCountComparison;
    return nameSortedItems.indexOf(a) - nameSortedItems.indexOf(b);
  });
};

// Returns a small visual color dot for common conductor colors.
// This is only a UI helper for the selected-material list inside the modal.
const getMaterialColorCode = (material) => {
  const name = getMaterialDisplayName(material).toLowerCase();
  if (name.includes('black')) return '#000000';
  if (name.includes('blue')) return '#1266d6';
  if (name.includes('brown')) return '#8b2f17';
  if (name.includes('gray') || name.includes('grey')) return '#9ca3af';
  if (name.includes('green')) return '#14883b';
  if (name.includes('orange')) return '#f97316';
  if (name.includes('purple')) return '#7e22ce';
  if (name.includes('red')) return '#dc2626';
  if (name.includes('white')) return '#f8fafc';
  if (name.includes('yellow')) return '#eab308';
  return '#64748b';
};


const CONDUCTOR_COLOR_NAMES = ['Black', 'Red', 'Blue', 'Orange', 'Brown', 'Yellow', 'White', 'Green', 'Gray', 'Grey', 'Purple'];

// Detects whether a material is a conductor color variant.
// Example: THHN Wire #12 Black -> color Black.
const getConductorColor = (material) => {
  if (String(material?.category || '').toLowerCase() !== 'conductors') return '';
  const materialName = String(material?.name || '').trim();
  const matchingColor = CONDUCTOR_COLOR_NAMES.find((color) => {
    const colorPattern = new RegExp(`\\b${color}\\b$`, 'i');
    return colorPattern.test(materialName);
  });
  if (!matchingColor) return '';
  return matchingColor === 'Grey' ? 'Gray' : matchingColor;
};

// Removes the trailing conductor color from a wire material name.
// Example: THHN Wire #12 Black -> THHN Wire #12.
// This lets all colors of the same wire family share one catalog card and one image.
const getConductorFamilyBaseName = (material) => {
  const color = getConductorColor(material);
  const materialName = String(material?.name || '').trim();
  if (!color) return getSortableBaseName(material);
  return materialName.replace(new RegExp(`\\s+${color}$`, 'i'), '').trim().toLowerCase();
};

const getConductorFamilyDisplayName = (material) => {
  const color = getConductorColor(material);
  const materialName = String(material?.name || '').trim();
  if (!color) return materialName || 'Unnamed Material';
  return materialName.replace(new RegExp(`\\s+${color}$`, 'i'), '').trim() || materialName;
};

const isConductorColorFamily = (material) => Boolean(getConductorColor(material));

// Returns the label shown on the variant buttons inside the add modal.
// Wire families show colors. Sized families show trade sizes.
const getFamilyVariantLabel = (variant, familyMode = '') => {
  if (familyMode === 'color') return getConductorColor(variant) || getMaterialDisplayName(variant);
  if (variant?.size && variant.size !== 'N/A') return variant.size;
  return getMaterialDisplayName(variant);
};
const isListStyleFamily = (variants) => {
  const safeVariants = Array.isArray(variants) ? variants : [];
  if (safeVariants.length <= 1) return false;
  return safeVariants.every((variant) => (
    variant?.familyDisplayMode === 'list' ||
    !variant?.size ||
    variant.size === 'N/A'
  ));
};

const normalizeLengthDetailForUnit = (value, unit) => {
  const clean = String(value || '').trim().toLowerCase();
  if (!clean) return '';
  const numericMatch = clean.match(/\d+(?:\.\d+)?/);
  if (!numericMatch) return String(value || '').trim();
  const numberText = numericMatch[0];
  if (unit === 'Length (in)') return `${numberText} in`;
  if (unit === 'Length (ft)') return `${numberText} ft`;
  return String(value || '').trim();
};


// A color dot specifically for the color selector buttons.
const getColorCodeByName = (colorName) => {
  const normalizedColor = String(colorName || '').toLowerCase();
  if (normalizedColor === 'black') return '#000000';
  if (normalizedColor === 'blue') return '#1266d6';
  if (normalizedColor === 'brown') return '#8b2f17';
  if (normalizedColor === 'gray' || normalizedColor === 'grey') return '#9ca3af';
  if (normalizedColor === 'green') return '#14883b';
  if (normalizedColor === 'orange') return '#f97316';
  if (normalizedColor === 'purple') return '#7e22ce';
  if (normalizedColor === 'red') return '#dc2626';
  if (normalizedColor === 'white') return '#f8fafc';
  if (normalizedColor === 'yellow') return '#eab308';
  return '#64748b';
};



// Builds a stable family key for materials that are the same item with different trade sizes.
// Example: EMT Conduit 1/2", 3/4", and 1" all become one visible catalog card.
// This reduces repeated catalog photos because the UI can show one image for the whole family.
const getMaterialFamilyKey = (material) => {
  const categoryKey = String(material?.category || 'Others').toLowerCase();
  const explicitFamilyName = String(material?.familyName || '').trim();
  if (explicitFamilyName) return `${categoryKey}::${explicitFamilyName.toLowerCase()}`;
  if (isConductorColorFamily(material)) {
    return `${categoryKey}::${getConductorFamilyBaseName(material)}`;
  }
  return `${categoryKey}::${getSortableBaseName(material)}`;
};

// Picks the best image for a family. The first saved photo in any size variant becomes
// the shared visual reference for the family card and the size-selection modal.
const getSharedFamilyImageUri = (variants) => {
  // Priority 1: Explicit group cover designated by the manager
  const coverOwner = (variants || []).find((v) => Boolean(v?.groupCoverUri));
  if (coverOwner?.groupCoverUri) return coverOwner.groupCoverUri;

  // Priority 2: Fallback to the first variant image if no explicit cover is set
  const imageOwner = (variants || []).find((variant) => Boolean(variant?.imageUri));
  return imageOwner?.imageUri || '';
};


// Shows the catalog-only description in a lightweight popup. The description
// helps the user choose the correct family variant, but it is never copied into
// the Material Quantity Sheet unless the user writes a custom note.
const showVariantDescription = (variant) => {
  const title = getMaterialDisplayName(variant);
  const description = String(variant?.description || '').trim();
  Alert.alert(title, description || 'No description has been added for this material yet.');
};


// Returns the compact helper text shown under each selectable family variant.
// Small descriptions are shown directly because they help the user choose fast.
// Long descriptions stay hidden behind the long-press popup to keep the list compact.
// Empty descriptions show no helper text at all.
const getVariantCompactHelperText = (variant) => {
  const description = String(variant?.description || '').trim();

  if (!description) return '';

  // Only show the description if explicitly enabled for this material.
  // This satisfies the requirement to clean up the UI by hiding descriptions
  // by default and only showing them when specifically needed.
  if (variant.forceShowDescription) {
    return description;
  }

  return '';
};

// Some field users prefer compact rows when a family has many variants. This
// helper returns the best secondary line for the selected-material preview.
const getSelectionPreviewDescription = (material) => {
  const description = String(material?.description || '').trim();
  const size = material?.size && material.size !== 'N/A' ? `Size: ${material.size}` : '';
  const color = getConductorColor(material);
  const fallback = color ? `Color: ${color}` : size;

  // Only show the description in the preview if forceShowDescription is true.
  // This keeps the selection modal clean for common materials like EMT or standard wires.
  if (material?.forceShowDescription && description) {
    return description;
  }

  return fallback;
};

// Creates the visual catalog list shown to the user. Sized families are collapsed
// into one card, while normal one-off materials still appear as normal rows.
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
        familyMode: 'single',
        imageUri: firstVariant.imageUri || getSharedFamilyImageUri(sortedVariants)
      };
    }

    const familyMode = hasColorVariants ? 'color' : (hasSizeVariants ? 'size' : 'list');
    const availableOptions = sortedVariants
      .map((variant) => getFamilyVariantLabel(variant, familyMode))
      .filter(Boolean);

    return {
      ...firstVariant,
      id: `family-${familyKey}`,
      isFamilyGroup: true,
      familyMode,
      familyKey,
      variants: sortedVariants,
      name: firstVariant.familyName || (hasColorVariants
        ? getConductorFamilyDisplayName(firstVariant)
        : firstVariant.name),
      size: 'N/A',
      imageUri: getSharedFamilyImageUri(sortedVariants),
      availableSizes: familyMode === 'size' ? availableOptions : [],
      availableColors: familyMode === 'color' ? availableOptions : [],
      availableNames: familyMode === 'list' ? availableOptions : []
    };
  });

  return sortCatalogForDisplay(displayItems, 'name');
};


// Returns the default units that should be shown for a material based on its category.
// This keeps the selection modal clean and avoids showing unnecessary units for every material.
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

// Quick catalog filters shown as chips above the list. They keep the catalog fast
// and easy to scan as it grows because the user can narrow the data set before
// typing a detailed search.
const ITEMS_PER_PAGE = 15;

const materialMatchesQuickFilter = (material, filterId) => {
  if (!filterId || filterId === 'all') return true;

  const category = String(material?.category || '').toLowerCase();

  // First check exact category match (for dynamic categories)
  if (category === filterId) return true;

  const searchableText = getSearchableMaterialText(material);

  // Fallback to keyword-based filtering for legacy/broad groups
  switch (filterId) {
    case 'wire':
    case 'conductors':
      return category === 'conductors' || /\b(wire|conductor|cable|thhn|xhhw)\b/.test(searchableText);
    case 'pipe':
    case 'conduits':
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
      return category === filterId;
  }
};

export default function CatalogScreen({ navigation, currentUser }) {
  const [categories, setCategories] = useState([]);
  const [catalog, setCatalog] = useState([]);
  const [filtered, setFiltered] = useState([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastSyncMessage, setLastSyncMessage] = useState('');
  const [sortMode, setSortMode] = useState('name');
  const [menuModalVisible, setMenuModalVisible] = useState(false);
  const [activeQuickFilter, setActiveQuickFilter] = useState('all');
  const [currentPage, setCurrentPage] = useState(1);
  const listRef = useRef(null);
  const timersRef = useRef({});

  const [modalVisible, setModalVisible] = useState(false);
  const [selectedItem, setSelectedItem] = useState(null);
  const [selectedFamilyVariants, setSelectedFamilyVariants] = useState([]);
  const [selectedFamilyVariantIds, setSelectedFamilyVariantIds] = useState([]);
  const [familyVariantQuantities, setFamilyVariantQuantities] = useState({});
  const [selectedItems, setSelectedItems] = useState([]);
  const [isMultiSelectMode, setIsMultiSelectMode] = useState(false);
  const [isAddingMultipleItems, setIsAddingMultipleItems] = useState(false);
  const [zoomImageUri, setZoomImageUri] = useState('');
  const [zoomVisible, setZoomVisible] = useState(false);

  const [quantity, setQuantity] = useState('1');
  const [unit, setUnit] = useState('Unit');
  const [lengthDetail, setLengthDetail] = useState('');
  const [note, setNote] = useState('');
  const [customUnit, setCustomUnit] = useState('');
  const [useCustomUnit, setUseCustomUnit] = useState(false);
  const [useBulkQuantity, setUseBulkQuantity] = useState(false);

  const totalPages = Math.max(1, Math.ceil(filtered.length / ITEMS_PER_PAGE));
  const paginatedMaterials = useMemo(() => {
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

  // Filters the catalog by material name, category, description, keywords, and trade size.
  // Size is parsed behind the scenes as a number, so "3/4" becomes 0.75 and
  // "1 1/8" becomes 1.125. This keeps searches accurate even when more sizes
  // are added to Firebase later.
  const applySearchFilter = (data, text, selectedSortMode = sortMode, selectedQuickFilter = activeQuickFilter) => {
    const quickFilteredData = (data || []).filter((material) => materialMatchesQuickFilter(material, selectedQuickFilter));

    if (!text.trim()) return buildCatalogDisplayItems(sortCatalogForDisplay(quickFilteredData, selectedSortMode));

    const { sizeNumber, searchTextWithoutSize } = extractSearchSize(text);
    const searchTerms = getSearchTerms(searchTextWithoutSize);
    const conduitSearchMode = sizeNumber !== null ? getConduitSearchMode(searchTextWithoutSize) : null;

    const matchingItems = quickFilteredData.filter((material) => {
      const hasRequestedSize = materialMatchesSearchSize(material, sizeNumber);

      if (!hasRequestedSize) return false;

      // Broad conduit searches with a size should show the whole trade-size group.
      // Example: "EMT 3/4" can return EMT conduit 3/4, EMT coupling 3/4,
      // grounding bushing 3/4, plastic bushing 3/4, white cap 3/4, etc.
      if (conduitSearchMode) {
        return isConduitSystemMaterial(material, conduitSearchMode);
      }

      // Normal searches still require the remaining words to match the material.
      // Example: "coupling 3/4" shows 3/4 couplings, not every 3/4 material.
      return materialMatchesAllSearchTerms(material, searchTerms);
    });

    return buildCatalogDisplayItems(sortCatalogForDisplay(matchingItems, selectedSortMode));
  };

  const applyCatalogToScreen = useCallback((data, shouldResetPage = true) => {
    const safeData = Array.isArray(data) ? data : [];
    setCatalog(safeData);
    setFiltered(applySearchFilter(safeData, search, sortMode, activeQuickFilter));
    if (shouldResetPage) setCurrentPage(1);
  }, [search, sortMode, activeQuickFilter]);

  const refreshCatalogFromFirebase = useCallback(async ({ showAlert = false } = {}) => {
    try {
      setRefreshing(true);
      const cloudCatalog = await StorageService.syncCatalogFromFirebase();
      applyCatalogToScreen(cloudCatalog, true);
      setLastSyncMessage(`Last sync: ${new Date().toLocaleTimeString()}`);
      if (showAlert) Alert.alert('Catalog Updated', 'The local catalog was refreshed from Firebase.');
      return cloudCatalog;
    } catch (error) {
      console.error('Catalog force refresh error:', error);
      setLastSyncMessage('Sync failed. Showing local catalog.');
      if (showAlert) Alert.alert('Sync Error', 'The app could not refresh Firebase right now. Local catalog is still available.');
      return null;
    } finally {
      setRefreshing(false);
    }
  }, [applyCatalogToScreen]);

  // Reload the catalog whenever this screen receives focus. Local cache opens
  // quickly, then Firebase refreshes the screen so added/deleted materials from
  // other users become visible without restarting the app.
  useFocusEffect(useCallback(() => {
    let isMounted = true;
    const load = async () => {
      try {
        const [localData, fetchedCategories] = await Promise.all([
          StorageService.loadCatalogCache(),
          StorageService.loadCategories()
        ]);
        if (isMounted) {
          if (localData.length > 0) {
            applyCatalogToScreen(localData, true);
          }
          setCategories(fetchedCategories);
          setLoading(false);
        }

        const cloudData = await StorageService.syncCatalogFromFirebase();
        if (isMounted) {
          applyCatalogToScreen(cloudData, true);
          setLastSyncMessage(`Last sync: ${new Date().toLocaleTimeString()}`);
        }
      } catch (e) {
        console.error('Catalog load focus error:', e);
        if (isMounted) {
          const fallbackData = await StorageService.loadCatalog();
          applyCatalogToScreen(fallbackData, true);
          setLastSyncMessage('Offline mode. Showing local catalog.');
        }
      } finally {
        if (isMounted) setLoading(false);
      }
    };

    load();

    // No polling interval here. The catalog syncs when this screen opens,
    // after catalog write actions, or when the user pulls down / taps Sync Now.
    // This keeps Firebase traffic low while still allowing manual refresh.
    return () => {
      isMounted = false;
    };
  }, []));

  // Handles the Android system Back button and Android back gesture.
  // Priority order:
  // 1. Close any open modal.
  // 2. Exit multiple-selection mode if it is active.
  // 3. Go back to the previous screen using React Navigation.
  // This keeps the phone's native Back control working the same way users expect.
  useFocusEffect(useCallback(() => {
    const handleDeviceBack = () => {
      if (menuModalVisible) {
        setMenuModalVisible(false);
        return true;
      }

      if (modalVisible) {
        setModalVisible(false);
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
  }, [navigation, menuModalVisible, modalVisible, isMultiSelectMode]));

  const handleSearch = (text) => {
    setSearch(text);
    setFiltered(applySearchFilter(catalog, text, sortMode, activeQuickFilter));
    setCurrentPage(1);
  };

  // Changes how the catalog is ordered without changing the search text.
  // Name is the default because it is predictable; Frequent uses requestCount
  // values saved in Firebase each time a material is added to the requisition.
  const changeSortMode = (newSortMode) => {
    setSortMode(newSortMode);
    setFiltered(applySearchFilter(catalog, search, newSortMode, activeQuickFilter));
    setCurrentPage(1);
    setMenuModalVisible(false);
  };

  const changeQuickFilter = (newQuickFilter) => {
    setActiveQuickFilter(newQuickFilter);
    setFiltered(applySearchFilter(catalog, search, sortMode, newQuickFilter));
    setCurrentPage(1);
    setMenuModalVisible(false);
  };

  // Determines which units should be displayed in the order modal for the selected material.
  // Older catalog records are also protected here by falling back to category defaults.
  const getAllowedUnits = (item) => {
    const units = Array.isArray(item?.allowedUnits) && item.allowedUnits.length > 0
      ? item.allowedUnits
      : getDefaultAllowedUnitsByCategory(item?.category);
    const normalizedUnits = units.includes('Rolls') ? units.map((currentUnit) => (currentUnit === 'Rolls' ? 'Reel' : currentUnit)) : units;
    // Do not append Custom Unit here. Catalog materials already define which
    // units they should show. A separate checkbox below lets the user override
    // with a one-time custom unit only when needed for the quantity sheet.
    return [...new Set(normalizedUnits)];
  };

  // Builds the list of units available for multiple selected materials.
  // The app uses the intersection of all selected materials so the chosen unit is valid for every row being added.
  const getCommonAllowedUnits = (items) => {
    if (!items.length) return ['Unit'];
    const firstItemUnits = getAllowedUnits(items[0]);
    const commonUnits = firstItemUnits.filter((unitOption) =>
      items.every((item) => getAllowedUnits(item).includes(unitOption))
    );
    return commonUnits.length > 0 ? commonUnits : firstItemUnits;
  };

  // Converts a catalog material into the lightweight material object used by the requisition list.
  // Catalog-only properties such as photo and long description are intentionally not copied to the draft table.
  const buildDraftMaterial = (item) => ({
    id: item.id,
    name: getMaterialDisplayName(item),
    category: item.category,
    size: item.size || 'N/A'
  });

  // Opens the order modal for one material and resets all temporary fields so each selection starts clean.
  const getInitialVariantForFamily = (item) => {
    const variants = item?.isFamilyGroup ? item.variants || [] : [item];
    const { sizeNumber } = extractSearchSize(search);

    if (sizeNumber !== null && sizeNumber !== undefined) {
      const matchingSizeVariant = variants.find((variant) => materialMatchesSearchSize(variant, sizeNumber));
      if (matchingSizeVariant) return matchingSizeVariant;
    }

    return variants[0] || item;
  };

  const openSelectionModal = (item) => {
    const variants = item?.isFamilyGroup ? item.variants || [] : [item];
    const initialVariant = getInitialVariantForFamily(item);
    const units = getAllowedUnits(initialVariant);

    // Family cards do not preselect a size or color. This prevents accidental
    // orders such as EMT Pipe defaulting to 1/2" or THHN #12 defaulting to Black.
    // The user must intentionally choose one or more options before adding.
    setSelectedItem(item?.isFamilyGroup ? item : initialVariant);
    setSelectedFamilyVariants(variants);
    setSelectedFamilyVariantIds(item?.isFamilyGroup ? [] : (initialVariant?.id ? [initialVariant.id] : []));
    setFamilyVariantQuantities(item?.isFamilyGroup ? {} : (initialVariant?.id ? { [initialVariant.id]: '1' } : {}));
    setSelectedItems([]);
    setIsAddingMultipleItems(false);
    setQuantity('1');
    setUnit(units[0] || 'Unit');
    setLengthDetail('');
    setCustomUnit('');
    setUseCustomUnit(false);
    setUseBulkQuantity(false);
    setNote('');
    setModalVisible(true);
  };

  const toggleFamilyVariant = (variant) => {
    const variantId = variant?.id;
    if (!variantId) return;

    setSelectedFamilyVariantIds((currentIds) => {
      const alreadySelected = currentIds.includes(variantId);
      const nextIds = alreadySelected
        ? currentIds.filter((currentId) => currentId !== variantId)
        : [...currentIds, variantId];

      if (!alreadySelected) {
        setFamilyVariantQuantities(prev => ({ ...prev, [variantId]: quantity || '1' }));
      } else {
        setFamilyVariantQuantities(prev => {
          const next = { ...prev };
          delete next[variantId];
          return next;
        });
      }

      // We no longer force at least one selection. If the user taps a selected
      // item again, it will be deselected, allowing for an empty selection state.
      const firstSelectedVariant = nextIds.length > 0
        ? selectedFamilyVariants.find((currentVariant) => currentVariant.id === nextIds[0])
        : null;

      if (firstSelectedVariant) {
        const units = getAllowedUnits(firstSelectedVariant);
        if (!units.includes(unit)) {
          setUnit(units[0] || 'Unit');
        }
        setSelectedItem(firstSelectedVariant);
      } else {
        // If nothing is selected, we keep the family reference if it exists,
        // but no specific variant is active for addition yet.
        setSelectedItem((prev) => (prev?.isFamilyGroup ? prev : variant));
      }

      return nextIds;
    });
  };

  // Turns multiple selection mode on or off. When the mode is turned off, all checkmarks are cleared.
  const toggleMultiSelectMode = () => {
    setIsMultiSelectMode((currentValue) => {
      if (currentValue) {
        setSelectedItems([]);
      }
      return !currentValue;
    });
  };

  // Adds or removes one material from the temporary multiple-selection basket.
  const toggleSelectedItem = (item) => {
    setSelectedItems((currentItems) => {
      const alreadySelected = currentItems.some((selected) => selected.id === item.id);
      if (alreadySelected) {
        return currentItems.filter((selected) => selected.id !== item.id);
      }
      return [...currentItems, item];
    });
  };

  // Opens the same quantity/unit modal for every selected material.
  // Example use: select five THHN #12 colors, then add 1 Reel of each color in one action.
  const openMultiSelectionModal = () => {
    if (selectedItems.length === 0) return;
    const commonUnits = getCommonAllowedUnits(selectedItems);
    setSelectedItem(null);
    setSelectedFamilyVariants([]);
    setIsAddingMultipleItems(true);
    setQuantity('1');
    setUnit(commonUnits[0] || 'Unit');
    setLengthDetail('');
    setCustomUnit('');
    setUseCustomUnit(false);
    setUseBulkQuantity(false);
    setNote('');
    setModalVisible(true);
  };

  // Sends one selected material to DraftScreen.
  // The catalog photo stays in the catalog and is not copied into the quantity sheet.
  const handleSingleAddConfirm = async () => {
    if (!selectedItem) return;

    if (selectedFamilyVariants.length > 1 && selectedFamilyVariantIds.length === 0) {
      Alert.alert(
        'Select Required',
        selectedItem?.category === 'Conductors'
          ? 'Please select at least one wire color before adding this material.'
          : selectedItem?.familyMode === 'list'
            ? 'Please select at least one material from this family before adding.'
            : 'Please select at least one trade size before adding this material.'
      );
      return;
    }

    const quantityNumber = isLengthUnit ? 1 : (parseInt(quantity, 10) || 1);
    if (useCustomUnit && !customUnit.trim()) {
      Alert.alert('Custom Unit Required', 'Please type the custom unit or uncheck Custom Unit.');
      return;
    }
    const normalizedLengthDetail = normalizeLengthDetailForUnit(lengthDetail, unit);
    const selectedFamilyItems = selectedFamilyVariantIds.length > 0
      ? selectedFamilyVariants.filter((variant) => selectedFamilyVariantIds.includes(variant.id))
      : [selectedItem];

    // If the user selected several colors or several sizes from one family card,
    // each selected option is sent as an individual row to the Material Quantity Sheet.
    if (selectedFamilyItems.length > 1) {
      const newItems = selectedFamilyItems.map((item) => {
        const itemQty = isLengthUnit ? 1 : (parseInt(familyVariantQuantities[item.id], 10) || 1);
        return {
          material: buildDraftMaterial(item),
          quantity: itemQty,
          unit: resolvedUnit,
          lengthDetail: (unit === 'Length (ft)' || unit === 'Length (in)' || unit === 'Reel') ? normalizedLengthDetail : '',
          description: note
        };
      });

      navigation.reset({
        index: 0,
        routes: [{ name: 'Draft', params: { newItems } }]
      });

      setModalVisible(false);
      setSelectedFamilyVariantIds([]);
      setFamilyVariantQuantities({});
      await StorageService.incrementMaterialRequestCount(selectedFamilyItems.map((item) => item.id));
      return;
    }

    const finalQty = isLengthUnit ? 1 : (parseInt(familyVariantQuantities[selectedFamilyItems[0]?.id] || quantity, 10) || 1);

    // Reset the navigation stack when returning to the main Draft screen.
    // This prevents repeated Draft/Catalog pages from accumulating if the user
    // moves back and forth many times while building a material requisition.
    navigation.reset({
      index: 0,
      routes: [{
        name: 'Draft',
        params: {
          newItem: {
            material: buildDraftMaterial(selectedFamilyItems[0] || selectedItem),
            quantity: finalQty,
            unit: resolvedUnit,
            lengthDetail: (unit === 'Length (ft)' || unit === 'Length (in)' || unit === 'Reel') ? normalizedLengthDetail : '',
            description: note
          }
        }
      }]
    });
    setModalVisible(false);
    setSelectedFamilyVariantIds([]);
    setFamilyVariantQuantities({});
    await StorageService.incrementMaterialRequestCount([(selectedFamilyItems[0] || selectedItem).id]);
  };

  // Sends several selected materials to DraftScreen using the same quantity, unit, length detail, and note.
  // DraftScreen receives an array and consolidates each row using the existing duplicate-checking rules.
  const handleMultipleAddConfirm = async () => {
    if (selectedItems.length === 0) return;
    const quantityNumber = isLengthUnit ? 1 : (parseInt(quantity, 10) || 1);
    if (useCustomUnit && !customUnit.trim()) {
      Alert.alert('Custom Unit Required', 'Please type the custom unit or uncheck Custom Unit.');
      return;
    }
    const normalizedLengthDetail = normalizeLengthDetailForUnit(lengthDetail, unit);
    const newItems = selectedItems.map((item) => ({
      material: buildDraftMaterial(item),
      quantity: quantityNumber,
      unit: resolvedUnit,
      lengthDetail: (unit === 'Length (ft)' || unit === 'Length (in)' || unit === 'Reel') ? normalizedLengthDetail : '',
      description: note
    }));

    // Reset the navigation stack when returning to the main Draft screen.
    // The selected materials are passed as route params, but no old Catalog
    // screens remain behind the user.
    navigation.reset({
      index: 0,
      routes: [{ name: 'Draft', params: { newItems } }]
    });
    setModalVisible(false);
    setSelectedItems([]);
    setIsMultiSelectMode(false);
    setIsAddingMultipleItems(false);
    await StorageService.incrementMaterialRequestCount(selectedItems.map((item) => item.id));
  };

  // Increases the modal quantity using buttons so the user does not need to rely only on the keyboard.
  const increaseQuantity = () => {
    if (selectedFamilyVariantIds.length > 1) {
      // Multiple items selected: if bulk adjust is active, increment every item by 1
      if (useBulkQuantity) {
        setFamilyVariantQuantities(prev => {
          const next = { ...prev };
          selectedFamilyVariantIds.forEach(id => {
            const currentVal = parseInt(next[id] || '1', 10);
            next[id] = String(currentVal + 1);
          });
          return next;
        });
      }
    } else {
      // Single item mode
      const currentQuantity = parseInt(quantity, 10) || 1;
      const nextVal = String(currentQuantity + 1);
      setQuantity(nextVal);
      if (selectedFamilyVariantIds[0]) {
        updateVariantQuantity(selectedFamilyVariantIds[0], nextVal);
      }
    }
  };

  // Decreases the modal quantity but never allows a value lower than 1.
  const decreaseQuantity = () => {
    if (selectedFamilyVariantIds.length > 1) {
      // Multiple items selected: if bulk adjust is active, decrement every item by 1 (min 1)
      if (useBulkQuantity) {
        setFamilyVariantQuantities(prev => {
          const next = { ...prev };
          selectedFamilyVariantIds.forEach(id => {
            const currentVal = parseInt(next[id] || '1', 10);
            next[id] = String(Math.max(1, currentVal - 1));
          });
          return next;
        });
      }
    } else {
      // Single item mode
      const currentQuantity = parseInt(quantity, 10) || 1;
      const nextVal = String(Math.max(1, currentQuantity - 1));
      setQuantity(nextVal);
      if (selectedFamilyVariantIds[0]) {
        updateVariantQuantity(selectedFamilyVariantIds[0], nextVal);
      }
    }
  };

  const handleBulkQuantityInputChange = (val) => {
    setQuantity(val);
    if (selectedFamilyVariantIds.length > 1) {
      if (useBulkQuantity) {
        // If bulk adjust is active, applying a manual number sets ALL to that number
        const next = {};
        selectedFamilyVariantIds.forEach(id => {
          next[id] = val;
        });
        setFamilyVariantQuantities(prev => ({ ...prev, ...next }));
      }
    } else {
      // Single selection: manual typing updates the only variant
      if (selectedFamilyVariantIds[0]) {
        updateVariantQuantity(selectedFamilyVariantIds[0], val);
      }
    }
  };

  const updateVariantQuantity = (variantId, newQty) => {
    setFamilyVariantQuantities(prev => ({ ...prev, [variantId]: newQty }));
  };

  const incrementVariantQuantity = (variantId) => {
    const current = parseInt(familyVariantQuantities[variantId] || '1', 10);
    updateVariantQuantity(variantId, String(current + 1));
  };

  const decrementVariantQuantity = (variantId) => {
    const current = parseInt(familyVariantQuantities[variantId] || '1', 10);
    updateVariantQuantity(variantId, String(Math.max(1, current - 1)));
  };

  const handleAddConfirm = async () => {
    if (isAddingMultipleItems) {
      await handleMultipleAddConfirm();
    } else {
      await handleSingleAddConfirm();
    }
  };

  const openZoom = (uri) => {
    if (!uri) return;
    setZoomImageUri(uri);
    setZoomVisible(true);
  };
  const activeModalItems = isAddingMultipleItems
    ? selectedItems
    : (
        selectedFamilyVariants.length > 1
          ? selectedFamilyVariants.filter((variant) => selectedFamilyVariantIds.includes(variant.id))
          : (selectedItem ? [selectedItem] : [])
      );
  const activeAllowedUnits = isAddingMultipleItems ? getCommonAllowedUnits(selectedItems) : getAllowedUnits(selectedItem);
  const resolvedUnit = useCustomUnit ? (customUnit.trim() || 'Custom Unit') : unit;
  const isLengthUnit = unit === 'Length (ft)' || unit === 'Length (in)';
  const shouldShowQuantityStep = !isLengthUnit;
  const sharedModalImageUri = selectedItem?.imageUri || getSharedFamilyImageUri(selectedFamilyVariants);

  if (loading) {
    return <SafeAreaView style={[styles.container, styles.centered]} edges={['left','right','bottom']}><ActivityIndicator size="large" color="#64ffda" /></SafeAreaView>;
  }

  return (
    <SafeAreaView style={styles.container} edges={['left','right','bottom']}>
      <View style={styles.topRow}>
        <TextInput
          style={styles.searchBar}
          placeholder="Search material, category, description, or keyword..."
          placeholderTextColor="#99a"
          value={search}
          onChangeText={handleSearch}
        />
        <TouchableOpacity style={styles.menuButton} onPress={() => setMenuModalVisible(true)}>
          <Text style={styles.menuButtonText}>Filter & Sort ⚙️</Text>
        </TouchableOpacity>
        {/* Catalog maintenance is intentionally handled in Catalog Manager from More Options. */}
      </View>

      <View style={styles.catalogActionRow}>
        <TouchableOpacity style={[styles.multiSelectButton, isMultiSelectMode && styles.multiSelectButtonActive]} onPress={toggleMultiSelectMode}>
          <Text style={[styles.multiSelectButtonText, isMultiSelectMode && styles.multiSelectButtonTextActive]}>
            {isMultiSelectMode ? 'Cancel Selection' : 'Select Multiple Materials'}
          </Text>
        </TouchableOpacity>
        {isMultiSelectMode ? <Text style={styles.selectedCounter}>{selectedItems.length} selected</Text> : null}
      </View>

      <View style={styles.paginationBar}>
        <TouchableOpacity style={[styles.pageButton, currentPage === 1 && styles.pageButtonDisabled]} onPress={() => goToPage(1)} disabled={currentPage === 1}>
          <Text style={styles.pageButtonText}>« First</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.pageButton, currentPage === 1 && styles.pageButtonDisabled]} onPress={() => goToPage(currentPage - 1)} disabled={currentPage === 1}>
          <Text style={styles.pageButtonText}>‹ Prev</Text>
        </TouchableOpacity>
        <Text style={styles.pageInfo}>Page {currentPage} / {totalPages} • {filtered.length} items</Text>
        <TouchableOpacity style={[styles.pageButton, currentPage === totalPages && styles.pageButtonDisabled]} onPress={() => goToPage(currentPage + 1)} disabled={currentPage === totalPages}>
          <Text style={styles.pageButtonText}>Next ›</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.pageButton, currentPage === totalPages && styles.pageButtonDisabled]} onPress={() => goToPage(totalPages)} disabled={currentPage === totalPages}>
          <Text style={styles.pageButtonText}>Last »</Text>
        </TouchableOpacity>
      </View>

      <FlatList
        ref={listRef}
        data={paginatedMaterials}
        keyExtractor={(item, index) => `${item.id || item.familyKey || item.name || 'material'}-${index}`}
        initialNumToRender={10}
        maxToRenderPerBatch={8}
        windowSize={7}
        updateCellsBatchingPeriod={60}
        removeClippedSubviews={true}
        keyboardShouldPersistTaps="handled"
        renderItem={({ item }) => {
          const initialVariant = item?.isFamilyGroup ? getInitialVariantForFamily(item) : item;
          const isSelected = selectedItems.some((selected) => selected.id === initialVariant.id);
          const displayName = item?.isFamilyGroup ? item.name : getMaterialDisplayName(item);
          const optionSummary = item?.isFamilyGroup && item.familyMode === 'color' && item.availableColors?.length
            ? `${item.availableColors.length} colors available: ${item.availableColors.join(', ')}`
            : item?.isFamilyGroup && item.familyMode === 'list' && item.availableNames?.length
              ? `${item.availableNames.length} materials available`
              : item?.isFamilyGroup && item.availableSizes?.length
                ? `${item.availableSizes.length} sizes available: ${item.availableSizes[0]} - ${item.availableSizes[item.availableSizes.length - 1]}`
                : null;

          return (
            <TouchableOpacity
              style={[styles.card, isSelected && styles.cardSelected]}
              onPress={() => isMultiSelectMode ? toggleSelectedItem(initialVariant) : openSelectionModal(item)}
            >
              {isMultiSelectMode ? (
                <View style={[styles.checkbox, isSelected && styles.checkboxActive]}>
                  <Text style={styles.checkboxText}>{isSelected ? '✓' : ''}</Text>
                </View>
              ) : null}
              {item.imageUri ? (
                <TouchableOpacity onPress={() => openZoom(item.imageUri)}>
                  <Image source={{ uri: item.imageUri }} style={styles.thumbnail} />
                </TouchableOpacity>
              ) : <View style={styles.thumbnailPlaceholder}><Text style={styles.thumbnailPlaceholderText}>No Photo</Text></View>}
              <View style={{ flex: 1 }}>
                <Text style={styles.itemName}>{displayName}</Text>
                <Text style={styles.itemCategory}>{item.category}</Text>
                {optionSummary ? <Text style={styles.sizeSummary}>{optionSummary}</Text> : null}
                {item.description ? <Text style={styles.itemDescription} numberOfLines={2}>{item.description}</Text> : null}
              </View>
              {!isMultiSelectMode ? <View style={styles.plusContainer}><Text style={styles.plus}>+</Text></View> : null}
            </TouchableOpacity>
          );
        }}
        contentContainerStyle={{ paddingBottom: isMultiSelectMode ? 150 : 90 }}
      />

      {isMultiSelectMode ? (
        <View style={styles.multiSelectFooter}>
          <TouchableOpacity
            style={[styles.addSelectedButton, selectedItems.length === 0 && styles.addSelectedButtonDisabled]}
            onPress={openMultiSelectionModal}
            disabled={selectedItems.length === 0}
          >
            <Text style={styles.addSelectedButtonText}>Add Selected Materials ({selectedItems.length})</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      <Modal visible={menuModalVisible} transparent animationType="slide">
        <View style={styles.sortModalOverlay}>
          <View style={styles.sortModalContent}>
            <Text style={styles.sortModalTitle}>Filters & Organization</Text>

            <Text style={styles.menuSectionTitle}>1. Filter by Category</Text>
            <ScrollView horizontal={false} style={{ maxHeight: 300 }} showsVerticalScrollIndicator={false}>
              <View style={styles.menuGrid}>
                <TouchableOpacity
                  key="all"
                  style={[styles.menuOption, activeQuickFilter === 'all' && styles.menuOptionActive]}
                  onPress={() => changeQuickFilter('all')}
                >
                  <Text style={[styles.menuOptionText, activeQuickFilter === 'all' && styles.menuOptionTextActive]}>
                    ALL
                  </Text>
                </TouchableOpacity>
                {categories.map((cat) => (
                  <TouchableOpacity
                    key={String(cat)}
                    style={[styles.menuOption, activeQuickFilter === String(cat).toLowerCase() && styles.menuOptionActive]}
                    onPress={() => changeQuickFilter(String(cat).toLowerCase())}
                  >
                    <Text style={[styles.menuOptionText, activeQuickFilter === String(cat).toLowerCase() && styles.menuOptionTextActive]}>
                      {String(cat).toUpperCase()}
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

            <TouchableOpacity style={styles.sortCloseButton} onPress={() => setMenuModalVisible(false)}>
              <Text style={styles.sortCloseText}>Close</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <Modal visible={modalVisible} transparent animationType="fade">
        <View style={styles.modalOverlay}>
          <SafeAreaView style={styles.modalSafeArea} edges={['top','left','right','bottom']}>
            <View style={styles.modalContent}>
              <TouchableOpacity
                style={styles.modalCloseButton}
                onPress={() => setModalVisible(false)}
                accessibilityRole="button"
                accessibilityLabel="Close material configuration"
              >
                <Text style={styles.modalCloseText}>×</Text>
              </TouchableOpacity>

              <Text style={styles.modalTitle}>{isAddingMultipleItems ? 'Add Multiple Materials' : 'Add Material'}</Text>
              <Text style={styles.modalHelpText}>
                {isAddingMultipleItems
                  ? 'The same quantity and unit will be applied to each selected material.'
                  : 'Choose the quantity and unit for this material.'}
              </Text>

              <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.modalScrollContent}>
                <View style={styles.modalSection}>
                  <View style={styles.sectionHeaderRow}>
                    <Text style={styles.sectionTitle}>
                      1. {isAddingMultipleItems ? `Selected Materials (${activeModalItems.length})` : 'Selected Material'}
                    </Text>
                    {isAddingMultipleItems ? (
                      <TouchableOpacity onPress={() => { setSelectedItems([]); setModalVisible(false); }}>
                        <Text style={styles.clearAllText}>Clear All 🗑</Text>
                      </TouchableOpacity>
                    ) : null}
                  </View>

                  <View style={styles.selectedRowsContainer}>
                    {activeModalItems.length === 0 ? (
                      <View style={styles.selectionRequiredRow}>
                        <Text style={styles.selectionRequiredText}>
                          {selectedItem?.category === 'Conductors'
                            ? 'No color selected yet. Choose one or more colors below.'
                            : 'No size selected yet. Choose one or more sizes below.'}
                        </Text>
                      </View>
                    ) : null}
                    {activeModalItems.map((item, index) => {
                      const previewDescription = getSelectionPreviewDescription(item);
                      return (
                        <View key={`${item.id || item.name || 'selected-material'}-${index}`} style={styles.selectedMaterialRow}>
                          {item.imageUri ? (
                            <TouchableOpacity onPress={() => openZoom(item.imageUri)}>
                              <Image source={{ uri: item.imageUri }} style={styles.selectedMaterialThumbnail} />
                            </TouchableOpacity>
                          ) : (
                            <View style={[styles.materialColorDot, { backgroundColor: getMaterialColorCode(item) }]} />
                          )}
                          <View style={styles.selectedMaterialInfo}>
                            <Text style={styles.selectedMaterialText} numberOfLines={1}>{getMaterialDisplayName(item)}</Text>
                            {previewDescription ? (
                              <Text
                                style={styles.selectedMaterialDescription}
                                numberOfLines={item.forceShowDescription ? 4 : 2}
                              >
                                {previewDescription}
                              </Text>
                            ) : null}
                          </View>

                          {!isAddingMultipleItems && !isLengthUnit && selectedFamilyVariants.length > 1 && (
                            <View style={styles.miniStepper}>
                              <TouchableOpacity
                                style={styles.miniStepperButton}
                                onPress={() => decrementVariantQuantity(item.id)}
                              >
                                <Text style={styles.miniStepperButtonText}>−</Text>
                              </TouchableOpacity>
                              <TextInput
                                style={styles.miniStepperInput}
                                keyboardType="numeric"
                                value={String(familyVariantQuantities[item.id] || '1')}
                                onChangeText={(val) => updateVariantQuantity(item.id, val)}
                                textAlign="center"
                              />
                              <TouchableOpacity
                                style={styles.miniStepperButton}
                                onPress={() => incrementVariantQuantity(item.id)}
                              >
                                <Text style={styles.miniStepperButtonText}>+</Text>
                              </TouchableOpacity>
                            </View>
                          )}

                          {isAddingMultipleItems ? (
                            <TouchableOpacity
                              style={styles.removeSelectedButton}
                              onPress={() => setSelectedItems((currentItems) => currentItems.filter((selected) => selected.id !== item.id))}
                            >
                              <Text style={styles.removeSelectedText}>×</Text>
                            </TouchableOpacity>
                          ) : null}
                        </View>
                      );
                    })}
                  </View>

                  {!isAddingMultipleItems && selectedItem?.description ? (
                    <Text style={styles.selectedDescription}>Description is shown above for selection only. It will not be added to the Material Quantity Sheet.</Text>
                  ) : null}
                </View>

                {!isAddingMultipleItems && selectedFamilyVariants.length > 1 ? (
                  <View style={styles.modalSection}>
                    <Text style={styles.sectionTitle}>2. Select {selectedItem?.category === 'Conductors' ? 'Color' : selectedItem?.familyMode === 'list' ? 'Material' : 'Size'}</Text>
                    <Text style={styles.sizeInstruction}>
                      {selectedItem?.category === 'Conductors'
                        ? 'Choose one or more wire colors. Each selected color will be added as an individual line.'
                        : selectedItem?.familyMode === 'list'
                          ? 'Choose one or more materials from this family. Each selected material will be added as an individual line.'
                          : 'Choose one or more trade sizes. Each selected size will be added as an individual line.'}
                    </Text>

                    {selectedFamilyVariants.some(v => v.imageUri) ? (
                      <View style={styles.subCatalogGrid}>
                        {selectedFamilyVariants.map((variant) => {
                          const isVariantSelected = selectedFamilyVariantIds.includes(variant.id);
                          const variantLabel = getFamilyVariantLabel(variant, selectedItem?.familyMode);

                          return (
                            <TouchableOpacity
                              key={variant.id}
                              style={[styles.subCatalogCard, isVariantSelected && styles.subCatalogCardActive]}
                              onPress={() => toggleFamilyVariant(variant)}
                            >
                              <View style={styles.subCatalogImageContainer}>
                                {variant.imageUri ? (
                                  <Image source={{ uri: variant.imageUri }} style={styles.subCatalogImage} />
                                ) : (
                                  <View style={styles.subCatalogPlaceholder}>
                                    <Text style={styles.subCatalogPlaceholderText}>No Photo</Text>
                                  </View>
                                )}
                                {isVariantSelected && (
                                  <View style={styles.subCatalogCheckBadge}>
                                    <Text style={styles.subCatalogCheckText}>✓</Text>
                                  </View>
                                )}
                              </View>
                              <View style={styles.subCatalogInfo}>
                                <Text style={[styles.subCatalogText, isVariantSelected && styles.subCatalogTextActive]} numberOfLines={2}>
                                  {variantLabel}
                                </Text>
                              </View>
                            </TouchableOpacity>
                          );
                        })}
                      </View>
                    ) : selectedItem?.category === 'Conductors' ? (
                      <View style={styles.colorSelectionGrid}>
                        {selectedFamilyVariants.map((variant) => {
                          const variantLabel = getFamilyVariantLabel(variant, 'color');
                          const isVariantSelected = selectedFamilyVariantIds.includes(variant.id);
                          return (
                            <TouchableOpacity
                              key={variant.id}
                              style={[styles.colorGridButton, isVariantSelected && styles.colorGridButtonActive]}
                              onPress={() => toggleFamilyVariant(variant)}
                              onPressIn={() => {
                                if (variant.description) {
                                  timersRef.current[variant.id] = setTimeout(() => {
                                    showVariantDescription(variant);
                                  }, 600);
                                }
                              }}
                              onPressOut={() => {
                                if (timersRef.current[variant.id]) {
                                  clearTimeout(timersRef.current[variant.id]);
                                  delete timersRef.current[variant.id];
                                }
                              }}
                            >
                              <View style={[styles.colorGridDot, { backgroundColor: getColorCodeByName(variantLabel) }]} />
                              <Text style={[styles.colorGridText, isVariantSelected && styles.colorGridTextActive]} numberOfLines={1}>
                                {variantLabel}
                              </Text>
                            </TouchableOpacity>
                          );
                        })}
                      </View>
                    ) : (
                      <View style={styles.sizeSelectionGrid}>
                        {selectedFamilyVariants.map((variant) => {
                          const isVariantSelected = selectedFamilyVariantIds.includes(variant.id);
                          return (
                            <TouchableOpacity
                              key={variant.id}
                              style={[styles.sizeGridButton, selectedItem?.familyMode === 'list' && styles.sizeGridButtonWide, isVariantSelected && styles.sizeGridButtonActive]}
                              onPress={() => toggleFamilyVariant(variant)}
                              onPressIn={() => {
                                if (variant.description) {
                                  timersRef.current[variant.id] = setTimeout(() => {
                                    showVariantDescription(variant);
                                  }, 600);
                                }
                              }}
                              onPressOut={() => {
                                if (timersRef.current[variant.id]) {
                                  clearTimeout(timersRef.current[variant.id]);
                                  delete timersRef.current[variant.id];
                                }
                              }}
                            >
                              <Text style={[styles.sizeGridButtonText, isVariantSelected && styles.sizeGridButtonTextActive]}>
                                {selectedItem?.familyMode === 'list' ? getMaterialDisplayName(variant) : variant.size}
                              </Text>
                              {variant.forceShowDescription && variant.description && (
                                <View style={styles.infoIndicator}>
                                  <Text style={styles.infoIndicatorText}>i</Text>
                                </View>
                              )}
                              {isVariantSelected && <View style={styles.sizeGridCheck}><Text style={styles.sizeGridCheckText}>✓</Text></View>}
                            </TouchableOpacity>
                          );
                        })}
                      </View>
                    )}
                  </View>
                ) : null}

                {shouldShowQuantityStep ? (
                <View style={[styles.modalSection, selectedFamilyVariantIds.length > 1 && !useBulkQuantity && styles.disabledSection]}>
                  <View style={styles.sectionHeaderRow}>
                    <Text style={styles.sectionTitle}>{!isAddingMultipleItems && selectedFamilyVariants.length > 1 ? '3' : '2'}. Quantity for Each Material</Text>
                    {selectedFamilyVariantIds.length > 1 && (
                      <TouchableOpacity
                        style={[styles.bulkToggle, useBulkQuantity && styles.bulkToggleActive]}
                        onPress={() => setUseBulkQuantity(!useBulkQuantity)}
                      >
                        <Text style={[styles.bulkToggleText, useBulkQuantity && styles.bulkToggleTextActive]}>
                          {useBulkQuantity ? '☑ Bulk Adjust' : '☐ Bulk Adjust'}
                        </Text>
                      </TouchableOpacity>
                    )}
                  </View>

                  <View style={[styles.quantityInfoRow, selectedFamilyVariantIds.length > 1 && !useBulkQuantity && { opacity: 0.5 }]}>
                    <View style={styles.quantityColumn}>
                      <View style={styles.quantityStepper}>
                        <TouchableOpacity
                          style={styles.quantityButton}
                          onPress={decreaseQuantity}
                          disabled={selectedFamilyVariantIds.length > 1 && !useBulkQuantity}
                        >
                          <Text style={styles.quantityButtonText}>−</Text>
                        </TouchableOpacity>
                        <TextInput
                          style={styles.quantityInput}
                          keyboardType="numeric"
                          value={quantity}
                          onChangeText={handleBulkQuantityInputChange}
                          textAlign="center"
                          editable={!(selectedFamilyVariantIds.length > 1 && !useBulkQuantity)}
                        />
                        <TouchableOpacity
                          style={styles.quantityButton}
                          onPress={increaseQuantity}
                          disabled={selectedFamilyVariantIds.length > 1 && !useBulkQuantity}
                        >
                          <Text style={styles.quantityButtonText}>+</Text>
                        </TouchableOpacity>
                      </View>
                      <Text style={styles.exampleTitle}>Example</Text>
                      <Text style={styles.exampleText}>
                        {selectedFamilyVariantIds.length > 1
                          ? 'Adjusting this will add/subtract from ALL selected materials above.'
                          : `If you enter ${quantity || '1'}, each material above will be added with quantity ${quantity || '1'}.`}
                      </Text>
                    </View>

                    <View style={styles.howItWorksBox}>
                      <Text style={styles.howItWorksTitle}>ⓘ  How it works</Text>
                      <Text style={styles.howItWorksText}>
                        {selectedFamilyVariantIds.length > 1
                          ? 'Activate "Bulk Adjust" to apply a global change to all selected items at once.'
                          : 'The quantity you enter will be applied to each selected material.'}
                      </Text>
                    </View>
                  </View>
                </View>
                ) : (
                  <View style={styles.modalSection}>
                    <Text style={styles.sectionTitle}>Length Material</Text>
                    <Text style={styles.howItWorksText}>This unit uses one material line with a specified length instead of a quantity count.</Text>
                  </View>
                )}

                <View style={styles.modalSection}>
                  <Text style={styles.sectionTitle}>{!isAddingMultipleItems && selectedFamilyVariants.length > 1 ? (shouldShowQuantityStep ? '4' : '3') : (shouldShowQuantityStep ? '3' : '2')}. Unit of Measure</Text>
                  <View style={styles.unitGrid}>
                    {activeAllowedUnits.map((currentUnit) => (
                      <TouchableOpacity
                        key={currentUnit}
                        style={[styles.unitSelector, unit === currentUnit && styles.unitSelectorActive]}
                        onPress={() => setUnit(currentUnit)}
                      >
                        <Text style={[styles.unitText, unit === currentUnit && styles.unitTextActive]}>{currentUnit}</Text>
                        {unit === currentUnit ? <Text style={styles.unitCheck}>✓</Text> : null}
                      </TouchableOpacity>
                    ))}
                  </View>
                  <Text style={styles.unitHint}>ⓘ  “Reel” will change to “Reels” when quantity is more than 1.</Text>

                  <TouchableOpacity
                    style={[styles.customUnitToggle, useCustomUnit && styles.customUnitToggleActive]}
                    onPress={() => setUseCustomUnit((current) => !current)}
                  >
                    <Text style={[styles.customUnitToggleText, useCustomUnit && styles.customUnitToggleTextActive]}>
                      {useCustomUnit ? '☑ Use custom unit for this request' : '☐ Use custom unit for this request'}
                    </Text>
                  </TouchableOpacity>

                  {useCustomUnit ? (
                    <TextInput
                      style={styles.lengthInput}
                      placeholder="Type one-time unit, e.g.: Pack, Pair, Can"
                      placeholderTextColor="#6b7280"
                      value={customUnit}
                      onChangeText={setCustomUnit}
                    />
                  ) : null}

                  {(unit === 'Length (ft)' || unit === 'Length (in)' || unit === 'Reel') ? (
                    <TextInput
                      style={styles.lengthInput}
                      placeholder={unit === 'Length (in)' ? 'Enter length in inches, e.g.: 36 in' : 'Enter length in feet, e.g.: 10 ft'}
                      placeholderTextColor="#6b7280"
                      value={lengthDetail}
                      onChangeText={setLengthDetail}
                    />
                  ) : null}
                </View>

                <View style={styles.modalSection}>
                  <View style={styles.noteTitleRow}>
                    <Text style={styles.sectionTitle}>{!isAddingMultipleItems && selectedFamilyVariants.length > 1 ? (shouldShowQuantityStep ? '5' : '4') : (shouldShowQuantityStep ? '4' : '3')}. Note / Job Site Destination </Text>
                    <Text style={styles.optionalText}>(Optional)</Text>
                  </View>
                  <View style={styles.noteInputWrapper}>
                    <TextInput
                      style={styles.noteInput}
                      placeholder="e.g.: Run from the main panel"
                      placeholderTextColor="#6b7280"
                      value={note}
                      onChangeText={setNote}
                    />
                    <Text style={styles.noteIcon}>▤</Text>
                  </View>
                </View>
              </ScrollView>

              <View style={styles.modalActions}>
                <TouchableOpacity style={styles.cancelButton} onPress={() => setModalVisible(false)}>
                  <Text style={styles.cancelButtonText}>×  Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.addAllButton} onPress={handleAddConfirm}>
                  <Text style={styles.addAllButtonText}>
                    ⊕  {isAddingMultipleItems ? `Add All (${activeModalItems.length}) Materials` : 'Add Material'}
                  </Text>
                </TouchableOpacity>
              </View>
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
  topRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 10 },
  searchBar: { flex: 1, backgroundColor: '#172a45', padding: 13, borderRadius: 10, color: '#e6f1ff', borderWidth: 1, borderColor: '#303c55' },
  menuButton: { marginLeft: 8, backgroundColor: '#112240', borderWidth: 1, borderColor: '#64ffda', paddingHorizontal: 12, height: 46, borderRadius: 10, justifyContent: 'center', alignItems: 'center' },
  menuButtonText: { color: '#64ffda', fontWeight: 'bold', fontSize: 12 },
  sortModalOverlay: { flex: 1, backgroundColor: 'rgba(2, 12, 27, 0.85)', justifyContent: 'center', alignItems: 'center', padding: 20 },
  sortModalContent: { width: '100%', backgroundColor: '#ccd6f6', borderRadius: 20, padding: 20, maxHeight: '85%' },
  sortModalTitle: { fontSize: 20, fontWeight: '900', color: '#0a192f', textAlign: 'center', marginBottom: 15 },
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
  sortCloseButton: { backgroundColor: '#0a192f', borderRadius: 12, padding: 14, alignItems: 'center', marginTop: 10 },
  sortCloseText: { color: '#fff', fontWeight: '900', fontSize: 15 },
  gearButton: { marginLeft: 10, backgroundColor: '#112240', width: 48, height: 48, borderRadius: 12, justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: '#64ffda' },
  gearText: { fontSize: 22 },
  catalogActionRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, gap: 8 },
  syncInfoRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, gap: 8 },
  multiSelectButton: { backgroundColor: '#112240', borderWidth: 1, borderColor: '#233554', paddingVertical: 9, paddingHorizontal: 12, borderRadius: 8 },
  multiSelectButtonActive: { borderColor: '#64ffda', backgroundColor: '#0d2b4f' },
  multiSelectButtonText: { color: '#ccd6f6', fontSize: 12, fontWeight: 'bold' },
  multiSelectButtonTextActive: { color: '#64ffda' },
  selectedCounter: { color: '#64ffda', fontWeight: 'bold', fontSize: 12 },
  card: { backgroundColor: '#112240', padding: 16, borderRadius: 10, marginBottom: 10, flexDirection: 'row', alignItems: 'center', borderLeftWidth: 4, borderLeftColor: '#64ffda' },
  cardSelected: { borderColor: '#64ffda', borderWidth: 1, backgroundColor: '#17345a' },
  checkbox: { width: 26, height: 26, borderRadius: 6, borderWidth: 1, borderColor: '#64ffda', marginRight: 10, justifyContent: 'center', alignItems: 'center' },
  checkboxActive: { backgroundColor: '#0275d8', borderColor: '#64ffda' },
  checkboxText: { color: '#fff', fontWeight: 'bold', fontSize: 16 },
  thumbnail: { width: 58, height: 58, borderRadius: 8, marginRight: 12, backgroundColor: '#172a45' },
  thumbnailPlaceholder: { width: 58, height: 58, borderRadius: 8, marginRight: 12, backgroundColor: '#172a45', justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: '#233554' },
  thumbnailPlaceholderText: { color: '#8892b0', fontSize: 9, fontWeight: 'bold' },
  itemName: { fontSize: 15, fontWeight: 'bold', color: '#ccd6f6' },
  itemCategory: { fontSize: 12, color: '#8892b0', marginTop: 3 },
  itemDescription: { fontSize: 11, color: '#64ffda', marginTop: 3 },
  sizeSummary: { fontSize: 11, color: '#93c5fd', marginTop: 3, fontWeight: '700' },
  plusContainer: { backgroundColor: '#233554', width: 32, height: 32, borderRadius: 16, justifyContent: 'center', alignItems: 'center' },
  plus: { fontSize: 18, color: '#64ffda', fontWeight: 'bold' },
  multiSelectFooter: { position: 'absolute', left: 15, right: 15, bottom: 18, backgroundColor: '#0a192f', paddingTop: 10 },
  addSelectedButton: { backgroundColor: '#0275d8', padding: 15, borderRadius: 10, alignItems: 'center', borderWidth: 1, borderColor: '#64ffda' },
  addSelectedButtonDisabled: { backgroundColor: '#233554', borderColor: '#33445f' },
  addSelectedButtonText: { color: '#fff', fontWeight: 'bold', textTransform: 'uppercase' },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(2, 12, 27, 0.82)', justifyContent: 'center', alignItems: 'center' },
  modalSafeArea: { flex: 1, width: '100%', justifyContent: 'center', alignItems: 'center', paddingHorizontal: 10, paddingVertical: 10 },
  modalContent: {
    backgroundColor: '#f8fbff',
    width: '100%',
    maxHeight: '96%',
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingTop: 16,
    paddingBottom: 12,
    borderWidth: 1,
    borderColor: '#c7d2e3',
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 10
  },
  modalCloseButton: { position: 'absolute', top: 10, right: 14, zIndex: 5, width: 34, height: 34, borderRadius: 17, justifyContent: 'center', alignItems: 'center' },
  modalCloseText: { fontSize: 32, lineHeight: 34, color: '#5f6b7a', fontWeight: '300' },
  modalTitle: { fontSize: 20, fontWeight: '900', color: '#111827', textAlign: 'center', marginTop: 4 },
  modalHelpText: { color: '#4b5563', fontSize: 13, textAlign: 'center', marginTop: 8, marginBottom: 12 },
  modalScrollContent: { paddingBottom: 8 },
  modalSection: { backgroundColor: '#fbfdff', borderWidth: 1, borderColor: '#dbe3ef', borderRadius: 8, padding: 10, marginBottom: 10 },
  sectionHeaderRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  sectionTitle: { color: '#075bc7', fontSize: 14, fontWeight: '900' },
  clearAllText: { color: '#dc2626', fontSize: 12, fontWeight: '800' },
  selectedRowsContainer: { borderWidth: 1, borderColor: '#dbe3ef', borderRadius: 8, overflow: 'hidden', backgroundColor: '#fff' },
  selectedMaterialRow: { minHeight: 48, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: '#e5eaf2' },
  selectedMaterialInfo: { flex: 1 },
  materialColorDot: { width: 13, height: 13, borderRadius: 7, marginRight: 12, borderWidth: 1, borderColor: '#cbd5e1' },
  selectedMaterialText: { color: '#111827', fontSize: 13, fontWeight: '800' },
  selectedMaterialDescription: { color: '#64748b', fontSize: 11, marginTop: 2, lineHeight: 15 },
  removeSelectedButton: { width: 30, height: 30, justifyContent: 'center', alignItems: 'center' },
  removeSelectedText: { color: '#718096', fontSize: 22, fontWeight: '300' },
  selectedDescription: { color: '#4b5563', fontSize: 12, marginTop: 8 },
  modalImage: { width: 96, height: 96, borderRadius: 12, alignSelf: 'center', marginTop: 10, backgroundColor: '#e5e7eb' },
  sizeInstruction: { color: '#4b5563', fontSize: 12, marginTop: 6, marginBottom: 8 },
  sizeGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 },
  sizeSelector: { minWidth: '22%', minHeight: 40, borderRadius: 8, borderWidth: 1, borderColor: '#b8c4d6', backgroundColor: '#fff', justifyContent: 'center', alignItems: 'center', paddingHorizontal: 8 },
  sizeSelectorActive: { backgroundColor: '#0867df', borderColor: '#0867df' },
  sizeSelectorText: { color: '#111827', fontSize: 13, fontWeight: '900' },
  sizeSelectorTextActive: { color: '#fff' },
  selectorColorDot: { width: 12, height: 12, borderRadius: 6, marginRight: 6, borderWidth: 1, borderColor: '#cbd5e1' },
  variantSelectorCardCompact: { backgroundColor: '#fff', borderWidth: 1, borderColor: '#cbd5e1', borderRadius: 9, paddingVertical: 10, paddingHorizontal: 10, marginBottom: 8 },
  colorBadge: { minWidth: 78, flexDirection: 'row', alignItems: 'center', marginRight: 10 },
  colorBadgeText: { color: '#111827', fontSize: 12, fontWeight: '900' },
  colorBadgeTextActive: { color: '#fff' },
  variantCheckbox: { width: 24, height: 24, borderRadius: 6, borderWidth: 1, borderColor: '#94a3b8', alignItems: 'center', justifyContent: 'center', marginLeft: 8 },
  variantCheckboxActive: { backgroundColor: '#0867df', borderColor: '#0867df' },
  variantCheck: { color: '#fff', fontSize: 12, fontWeight: '900', marginLeft: 6 },
  quantityInfoRow: { flexDirection: 'row', gap: 10, marginTop: 10 },
  quantityColumn: { flex: 1 },
  quantityStepper: { height: 44, flexDirection: 'row', borderWidth: 1, borderColor: '#b8c4d6', borderRadius: 7, overflow: 'hidden', backgroundColor: '#fff' },
  quantityButton: { width: 54, justifyContent: 'center', alignItems: 'center', backgroundColor: '#eef3fb' },
  quantityButtonText: { color: '#075bc7', fontSize: 25, fontWeight: '400' },
  quantityInput: { flex: 1, color: '#111827', fontSize: 22, fontWeight: '700', paddingVertical: 0 },
  exampleTitle: { color: '#111827', fontSize: 12, fontWeight: '800', marginTop: 8 },
  exampleText: { color: '#4b5563', fontSize: 12, lineHeight: 17, marginTop: 2 },
  howItWorksBox: { flex: 1, borderWidth: 1, borderColor: '#d0dae8', borderRadius: 7, padding: 10, justifyContent: 'center', backgroundColor: '#fbfdff' },
  howItWorksTitle: { color: '#075bc7', fontWeight: '900', fontSize: 13, marginBottom: 8 },
  howItWorksText: { color: '#4b5563', fontSize: 12, lineHeight: 18 },
  unitGrid: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 10 },
  unitSelector: { backgroundColor: '#fff', minHeight: 42, borderRadius: 7, marginBottom: 6, width: '31%', alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: '#b8c4d6', flexDirection: 'row' },
  unitSelectorActive: { backgroundColor: '#0867df', borderColor: '#0867df' },
  unitText: { fontSize: 13, color: '#111827', fontWeight: '800' },
  unitTextActive: { color: '#fff' },
  unitCheck: { color: '#fff', fontSize: 15, marginLeft: 8, fontWeight: '900' },
  unitHint: { color: '#6b7280', fontSize: 11, marginTop: 4 },
  customUnitToggle: { marginTop: 10, backgroundColor: '#fff', borderWidth: 1, borderColor: '#b8c4d6', borderRadius: 7, padding: 10 },
  customUnitToggleActive: { backgroundColor: '#e6f0ff', borderColor: '#0867df' },
  customUnitToggleText: { color: '#111827', fontWeight: '800', fontSize: 12 },
  customUnitToggleTextActive: { color: '#0867df' },
  lengthInput: { marginTop: 10, borderWidth: 1, borderColor: '#b8c4d6', borderRadius: 7, paddingHorizontal: 10, height: 42, color: '#111827', backgroundColor: '#fff' },
  noteTitleRow: { flexDirection: 'row', alignItems: 'center' },
  optionalText: { fontWeight: '500', color: '#075bc7' },
  noteInputWrapper: { height: 42, borderWidth: 1, borderColor: '#b8c4d6', borderRadius: 7, backgroundColor: '#fff', flexDirection: 'row', alignItems: 'center', marginTop: 8 },
  noteInput: { flex: 1, color: '#111827', paddingHorizontal: 10, fontSize: 13 },
  noteIcon: { color: '#4b5563', marginRight: 10, fontSize: 18 },
  modalActions: { flexDirection: 'row', justifyContent: 'space-between', gap: 10, marginTop: 10 },
  cancelButton: { flex: 0.9, height: 48, borderRadius: 7, alignItems: 'center', justifyContent: 'center', backgroundColor: '#fff', borderWidth: 1, borderColor: '#8793a3' },
  cancelButtonText: { color: '#4b5563', fontWeight: '800', fontSize: 14 },
  addAllButton: { flex: 1.7, height: 48, borderRadius: 7, alignItems: 'center', justifyContent: 'center', backgroundColor: '#0867df' },
  addAllButtonText: { color: '#fff', fontWeight: '900', fontSize: 14 }
,


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
    gap: 4,
    paddingHorizontal: 8,
    paddingBottom: 8,
    marginBottom: 4
  },
  sizeSelectionGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    marginTop: 10,
    justifyContent: 'flex-start'
  },
  colorSelectionGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 10,
    justifyContent: 'flex-start'
  },
  colorGridButton: {
    width: '23%',
    height: 44,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#b8c4d6',
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 4
  },
  colorGridButtonActive: {
    backgroundColor: '#eef3fb',
    borderColor: '#0867df',
    borderWidth: 2
  },
  colorGridDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    marginBottom: 2,
    borderWidth: 0.5,
    borderColor: '#999'
  },
  colorGridText: {
    color: '#111827',
    fontSize: 11,
    fontWeight: '800',
    textAlign: 'center'
  },
  colorGridTextActive: {
    color: '#0867df'
  },
  sizeGridButton: {
    width: '31%',
    height: 44,
    backgroundColor: '#fff',
    borderWidth: 1.5,
    borderColor: '#b8c4d6',
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
    position: 'relative'
  },
  sizeGridButtonActive: {
    backgroundColor: '#0867df',
    borderColor: '#0867df'
  },
  sizeGridButtonText: {
    color: '#111827',
    fontSize: 14,
    fontWeight: '900'
  },
  sizeGridButtonTextActive: {
    color: '#fff'
  },
  sizeGridCheck: {
    position: 'absolute',
    top: -6,
    right: -6,
    backgroundColor: '#10b981',
    width: 20,
    height: 20,
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 2,
    borderColor: '#fff'
  },
  sizeGridCheckText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: 'bold'
  },
  descriptionBadge: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginTop: 4,
    backgroundColor: '#f1f5f9',
    paddingHorizontal: 6,
    paddingVertical: 4,
    borderRadius: 4,
    borderLeftWidth: 3,
    borderLeftColor: '#0867df'
  },
  infoIndicator: {
    position: 'absolute',
    top: 2,
    left: 2,
    backgroundColor: '#0867df',
    width: 14,
    height: 14,
    borderRadius: 7,
    justifyContent: 'center',
    alignItems: 'center'
  },
  infoIndicatorText: {
    color: '#fff',
    fontSize: 9,
    fontWeight: 'bold'
  },
  descriptionBadgeLabel: {
    fontSize: 9,
    fontWeight: '900',
    color: '#0867df'
  },
  pageButton: {
    backgroundColor: '#112240',
    borderColor: '#64ffda',
    borderWidth: 1,
    borderRadius: 9,
    paddingVertical: 7,
    paddingHorizontal: 7,
    minWidth: 50,
    alignItems: 'center'
  },
  pageButtonDisabled: { opacity: 0.35 },
  pageButtonText: { color: '#64ffda', fontWeight: '700', fontSize: 12 },
  pageInfo: { color: '#ccd6f6', fontWeight: '700', fontSize: 12, paddingHorizontal: 4 },

  selectedMaterialThumbnail: {
    width: 40,
    height: 40,
    borderRadius: 6,
    marginRight: 10,
    backgroundColor: '#e5e7eb'
  },
  gridThumbnail: {
    width: 24,
    height: 24,
    borderRadius: 4,
    marginBottom: 2,
    backgroundColor: '#f3f4f6'
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

  miniStepper: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#cbd5e1',
    borderRadius: 6,
    overflow: 'hidden',
    backgroundColor: '#fff',
    marginLeft: 8
  },
  miniStepperButton: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    backgroundColor: '#f1f5f9'
  },
  miniStepperButtonText: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#075bc7'
  },
  miniStepperInput: {
    width: 32,
    fontSize: 13,
    fontWeight: 'bold',
    color: '#1e293b',
    padding: 0
  },

  // Sub-Catalog Layout Styles
  subCatalogGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
    marginTop: 10,
    justifyContent: 'space-between',
    paddingHorizontal: 2
  },
  subCatalogCard: {
    width: '47%',
    backgroundColor: '#fff',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#dbe3ef',
    overflow: 'hidden',
    marginBottom: 4,
    elevation: 2,
    shadowColor: '#000',
    shadowOpacity: 0.1,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 }
  },
  subCatalogCardActive: {
    borderColor: '#0867df',
    borderWidth: 2,
    backgroundColor: '#eff6ff'
  },
  subCatalogImageContainer: {
    width: '100%',
    height: 100,
    backgroundColor: '#f8fafc',
    position: 'relative',
    justifyContent: 'center',
    alignItems: 'center'
  },
  subCatalogImage: {
    width: '100%',
    height: '100%',
    resizeMode: 'contain'
  },
  subCatalogPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center'
  },
  subCatalogPlaceholderText: {
    color: '#94a3b8',
    fontSize: 10,
    fontWeight: 'bold'
  },
  subCatalogInfo: {
    padding: 8,
    alignItems: 'center',
    minHeight: 44,
    justifyContent: 'center'
  },
  subCatalogText: {
    fontSize: 12,
    fontWeight: '800',
    color: '#1e293b',
    textAlign: 'center'
  },
  subCatalogTextActive: {
    color: '#0867df'
  },
  subCatalogCheckBadge: {
    position: 'absolute',
    top: 6,
    right: 6,
    backgroundColor: '#10b981',
    width: 22,
    height: 22,
    borderRadius: 11,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: '#fff',
    elevation: 3
  },
  subCatalogCheckText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: 'bold'
  },
  bulkToggle: {
    backgroundColor: '#f1f5f9',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#cbd5e1'
  },
  bulkToggleActive: {
    backgroundColor: '#eff6ff',
    borderColor: '#0275d8'
  },
  bulkToggleText: {
    fontSize: 11,
    fontWeight: 'bold',
    color: '#475569'
  },
  bulkToggleTextActive: {
    color: '#0275d8'
  },
  disabledSection: {
    borderColor: '#e5eaf2',
    backgroundColor: '#f9fafb'
  }
});

/**
 * StorageService
 * --------------
 * Central data layer for the application. The service keeps the draft list in
 * local AsyncStorage and keeps the material catalog in Firebase Realtime
 * Database.
 *
 * The service also normalizes old catalog records so older materials continue
 * working after new features are added, such as descriptions, photos, ids, and
 * category-based unit defaults.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SQLite from 'expo-sqlite';
import * as FileSystem from 'expo-file-system/legacy';
import * as ImageManipulator from 'expo-image-manipulator';
import { initialCatalog } from './catalogData';
import { FIREBASE_CONFIG } from './firebaseConfig';
import { AuthService } from './authService';

const DRAFT_KEY = '@material_draft_v1';
const GUEST_DRAFT_KEY = '@material_draft_guest_temp_v1';

const createDraftStorageKey = (sessionKey = '') => {
  const cleanSessionKey = String(sessionKey || '').trim();
  if (!cleanSessionKey || cleanSessionKey === 'guest') {
    return GUEST_DRAFT_KEY;
  }

  return `${DRAFT_KEY}_${cleanSessionKey.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
};
const CATALOG_CACHE_KEY = '@material_catalog_cache_v3';
const SQLITE_DATABASE_NAME = 'material_catalog_local_cache.db';
const CATALOG_TABLE_NAME = 'catalog_materials';
const IMPORTANT_INFO_TABLE_NAME = 'important_info_items';
const CABLE_CATALOG_TABLE_NAME = 'cable_catalog_items';
const CABLE_REQUIREMENT_TABLE_NAME = 'cable_requirement_drafts';
const LOCAL_IMAGE_CACHE_ROOT = `${FileSystem.documentDirectory || ''}hrocker-image-cache/`;
const CATALOG_IMAGE_CACHE_DIR = `${LOCAL_IMAGE_CACHE_ROOT}catalog/`;
const IMPORTANT_INFO_IMAGE_CACHE_DIR = `${LOCAL_IMAGE_CACHE_ROOT}important-info/`;

const SIZE_OPTIONS = ['1/2"', '3/4"', '1"', '1 1/4"', '1 1/2"', '2"', '2 1/4"', '2 1/2"', '3"', '3 1/2"', '4"'];

const extractLegacySizeFromName = (material) => {
  const originalName = (material.name || '').trim();
  const existingSize = (material.size || '').trim();

  if (existingSize && existingSize !== 'N/A') {
    return { name: originalName || 'Unnamed Material', size: existingSize };
  }

  const matchingSize = [...SIZE_OPTIONS]
    .sort((a, b) => b.length - a.length)
    .find((sizeOption) => originalName.endsWith(` ${sizeOption}`) || originalName === sizeOption);

  if (!matchingSize) {
    return { name: originalName || 'Unnamed Material', size: existingSize || 'N/A' };
  }

  return {
    name: originalName.replace(new RegExp(`\\s+${matchingSize.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), '').trim() || originalName,
    size: matchingSize
  };
};

const getMaterialDisplayName = (material) => {
  const sizeText = material.size && material.size !== 'N/A' ? ` ${material.size}` : '';
  return `${material.name || 'Unnamed Material'}${sizeText}`;
};


// Firebase Realtime Database REST endpoint for the shared material catalog.
// The catalog is stored under /materials so the root database can later keep other app data.
const FIREBASE_DATABASE_URL = FIREBASE_CONFIG.databaseURL;
const MATERIALS_ENDPOINT = `${FIREBASE_DATABASE_URL}/materials.json`;
const CATEGORIES_ENDPOINT = `${FIREBASE_DATABASE_URL}/categories.json`;
const UNIT_MEASURES_ENDPOINT = `${FIREBASE_DATABASE_URL}/unitMeasures.json`;
const IMPORTANT_INFO_ENDPOINT = `${FIREBASE_DATABASE_URL}/importantInfo.json`;
const CABLE_CATALOG_ENDPOINT = `${FIREBASE_DATABASE_URL}/cableCatalog.json`;
const CABLE_REQUIREMENTS_ENDPOINT = `${FIREBASE_DATABASE_URL}/cableRequirementDrafts`;
const CABLE_CATALOG_CACHE_KEY = '@cable_catalog_cache_v1';
const CABLE_REQUIREMENT_DRAFT_KEY = '@cable_requirement_draft_v1';
const CABLE_CATALOG_META_KEY = '@cable_catalog_meta_v1';
const CABLE_CATALOG_META_ENDPOINT = `${FIREBASE_DATABASE_URL}/meta/cableCatalog.json`;
const CATALOG_META_ENDPOINT = `${FIREBASE_DATABASE_URL}/meta/catalog.json`;
const CATALOG_STORAGE_FOLDER = 'catalog-thumbnails';
// Important Info keeps full-quality reference photos. The catalog only stores
// tiny visual thumbnails so Firebase downloads stay low on the Spark plan.
const IMPORTANT_INFO_STORAGE_FOLDER = 'important-info-images';
const CATEGORIES_CACHE_KEY = '@material_categories_cache_v1';
const UNIT_MEASURES_CACHE_KEY = '@material_unit_measures_cache_v1';
const IMPORTANT_INFO_CACHE_KEY = '@important_info_cache_v1';
const CATALOG_CACHE_SCHEMA_KEY = '@material_catalog_cache_schema_version';
const CATALOG_CACHE_SCHEMA_VERSION = 'incremental-sync-preserve-individual-images-v5';
const CATALOG_CLOUD_UPDATED_AT_KEY = '@material_catalog_cloud_updated_at_v1';
const CATALOG_LAST_INCREMENTAL_SYNC_AT_KEY = '@material_catalog_last_incremental_sync_at_v1';
const SETTINGS_CLOUD_UPDATED_AT_KEY = '@material_settings_cloud_updated_at_v1';
const CATALOG_DELETED_ENDPOINT = `${FIREBASE_DATABASE_URL}/catalogDeleted.json`;
const SETTINGS_META_ENDPOINT = `${FIREBASE_DATABASE_URL}/meta/settings.json`;

// Default catalog categories and unit measures. These are kept locally so the
// app always works offline, and owner accounts can also seed them into Firebase
// so all devices share the same master lists.
const DEFAULT_CATEGORIES = ['Conduits', 'Connectors', 'Conductors', 'Devices', 'Boxes', 'Fittings', 'Tools', 'Others'];
const DEFAULT_CATEGORY_KEYS = DEFAULT_CATEGORIES.map((category) => category.toLowerCase());
const DEFAULT_UNIT_MEASURES = ['Unit', 'Box', 'Bundle', 'Reel', 'Length (ft)', 'Length (in)', 'Bottle'];
const createCategoryKey = (category) => String(category || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const createUnitMeasureKey = (unit) => String(unit || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const buildAuthenticatedFirebaseUrl = async (baseUrl) => {
  const idToken = await AuthService.getCurrentIdToken();
  if (!idToken) throw new Error('OWNER_SESSION_TOKEN_MISSING');
  return `${baseUrl}?auth=${encodeURIComponent(idToken)}`;
};
const normalizeCategoryName = (value) => String(value || '').trim();
const normalizeCategoryKey = (value) => normalizeCategoryName(value).toLowerCase();

const CONDUCTOR_COLOR_NAMES = ['Black', 'Red', 'Blue', 'Orange', 'Brown', 'Yellow', 'White', 'Green', 'Gray', 'Grey', 'Purple'];

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

const getConductorFamilyBaseName = (material) => {
  const color = getConductorColor(material);
  const materialName = String(material?.name || '').trim();
  if (!color) return getSortableBaseName(material);
  return materialName.replace(new RegExp(`\\s+${color}$`, 'i'), '').trim();
};

const getConductorFamilyDisplayName = (material) => {
  const color = getConductorColor(material);
  const materialName = String(material?.name || '').trim();
  if (!color) return materialName || 'Unnamed Material';
  return materialName.replace(new RegExp(`\\s+${color}$`, 'i'), '').trim() || materialName;
};

const isConductorColorFamily = (material) => Boolean(getConductorColor(material));

// Fallback audit label used only when no user session is available yet.
const FALLBACK_USER_LABEL = 'shared-app-user';

const getCurrentAuditUserLabel = async () => {
  try {
    return await AuthService.getCurrentUserDisplayName();
  } catch (error) {
    console.error('StorageService Warning (audit user):', error);
    return FALLBACK_USER_LABEL;
  }
};

const ensureSharedDataEditor = async () => {
  await AuthService.ensureCanEditSharedData();
};

const ensureSharedDataOwner = async () => {
  const isOwner = await AuthService.isOwner();
  if (!isOwner) throw new Error('ONLY_OWNER_CAN_RUN_STORAGE_RECOVERY');
};

const getDefaultAllowedUnitsByCategory = (category) => {
  switch ((category || '').toLowerCase()) {
    case 'conductors':
      return ['Unit', 'Reel', 'Length (ft)'];
    case 'conduits':
      return ['Unit', 'Bundle'];
    case 'devices':
      return ['Unit', 'Box'];
    case 'boxes':
    case 'connectors':
    case 'fittings':
    case 'tools':
      return ['Unit', 'Box'];
    case 'others':
    default:
      return ['Unit', 'Box', 'Bundle'];
  }
};

const normalizeAllowedUnits = (allowedUnits, category) => {
  if (Array.isArray(allowedUnits) && allowedUnits.length > 0) {
    const normalizedUnits = allowedUnits.map((unit) => (unit === 'Rolls' ? 'Reel' : unit));
    const legacyAllUnits = ['Unit', 'Box', 'Bundle', 'Reel', 'Length (ft)'];
    const looksLikeOldDefault = legacyAllUnits.every((unit) => normalizedUnits.includes(unit));

    // Older records were saved with every unit active. For those records, apply the new category default.
    // Materials that were manually customized with a smaller set keep their saved selection.
    if (looksLikeOldDefault && normalizedUnits.length === legacyAllUnits.length) {
      return getDefaultAllowedUnitsByCategory(category);
    }

    return normalizedUnits;
  }
  return getDefaultAllowedUnitsByCategory(category);
};

const createMaterialIdentifier = (material) => {
  const normalizedLegacyFields = extractLegacySizeFromName(material);
  const baseText = `${normalizedLegacyFields.name || ''}-${material.category || ''}-${normalizedLegacyFields.size || ''}`;
  return baseText
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || `material-${Date.now()}`;
};

const buildAutomaticKeywords = (material, normalizedLegacyFields) => {
  const keywordSource = [
    normalizedLegacyFields.name,
    material.category,
    normalizedLegacyFields.size,
    material.description,
    ...(Array.isArray(material.keywords) ? material.keywords : [])
  ];

  const lowerName = (normalizedLegacyFields.name || '').toLowerCase();
  const automaticAliases = [];

  if (lowerName.includes('conduit')) automaticAliases.push('pipe', 'tube', 'raceway');
  if (lowerName.includes('pipe')) automaticAliases.push('conduit', 'tube', 'raceway');
  if (lowerName.includes('coupling')) automaticAliases.push('connector', 'joiner', 'fitting');
  if (lowerName.includes('connector')) automaticAliases.push('coupling', 'fitting');
  if (lowerName.includes('sealtite')) automaticAliases.push('seal tight', 'liquid tight', 'flexible conduit');
  if (lowerName.includes('bushing')) automaticAliases.push('protector', 'conduit end');
  if (lowerName.includes('uni-strut') || lowerName.includes('unistrut')) automaticAliases.push('strut', 'channel', 'clamp');
  if (lowerName.includes('wire')) automaticAliases.push('conductor', 'cable');

  // Wire search helper: this lets searches like "THHN # 12", "THHN #12", or "gauge 12" find all matching wire colors.
  // Add more general automatic keyword rules here when a search term should apply to many existing records.
  const wireMatch = lowerName.match(/(thhn|xhhw)\s+wire\s+#(\d+)/i);
  if (wireMatch) {
    const wireType = wireMatch[1].toLowerCase();
    const gaugeNumber = wireMatch[2];
    automaticAliases.push(`${wireType} #${gaugeNumber}`, `${wireType} # ${gaugeNumber}`, `${wireType} ${gaugeNumber}`, `#${gaugeNumber}`, `# ${gaugeNumber}`, `gauge ${gaugeNumber}`);

    if (gaugeNumber === '14' || gaugeNumber === '16') {
      automaticAliases.push('a/c', 'ac', 'air conditioning', 'thermostat', 'lead lag', 'leadlag', 'control wire');
    }
  }

  return [...new Set([...keywordSource, ...automaticAliases]
    .filter(Boolean)
    .flatMap((value) => String(value).split(','))
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean))];
};


const isInlineImageDataUri = (value) => typeof value === 'string' && value.startsWith('data:image') && value.includes('base64,');

const sanitizeImageFileName = (value) => String(value || 'image')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '') || `image-${Date.now()}`;

const getImageExtensionFromDataUri = (dataUri) => {
  const mimeMatch = String(dataUri || '').match(/^data:image\/(png|jpeg|jpg|webp);base64,/i);
  if (!mimeMatch) return 'jpg';
  return mimeMatch[1].toLowerCase() === 'jpeg' ? 'jpg' : mimeMatch[1].toLowerCase();
};

const ensureDirectoryExists = async (directoryUri) => {
  if (!FileSystem.documentDirectory) return false;
  const info = await FileSystem.getInfoAsync(directoryUri);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(directoryUri, { intermediates: true });
  }
  return true;
};


const sanitizeStoragePathSegment = (value) => sanitizeImageFileName(value || 'image');

const createStableStorageFilePath = ({ folder, fileKey, extension = 'jpg' }) => {
  const safeFolder = String(folder || '').split('/').filter(Boolean).map(sanitizeStoragePathSegment).join('/');
  const safeKeyPath = String(fileKey || 'image')
    .split('/')
    .filter(Boolean)
    .map(sanitizeStoragePathSegment)
    .join('/');

  return `${safeFolder}/${safeKeyPath}.${extension}`;
};

const createMaterialImageStorageKey = (materialId) => `materials/${materialId || 'unknown-material'}/thumbnail`;
const createFamilyCoverStorageKey = (familyNameOrId) => `families/${familyNameOrId || 'unknown-family'}/cover`;
const createImportantInfoStorageKey = (infoId) => `${infoId || 'unknown-info'}/image`;

/**
 * Uploads an image data URI to Firebase Storage and returns a small metadata object.
 * Realtime Database receives only the download URL and storage path, not the base64 image.
 * This keeps Realtime Database downloads low and prevents SQLite/AsyncStorage from filling up.
 */
const getBase64PayloadFromDataUri = (dataUri) => String(dataUri || '').split('base64,')[1] || '';

const getContentTypeFromDataUri = (dataUri) => {
  const mimeMatch = String(dataUri || '').match(/^data:(image\/(?:png|jpeg|jpg|webp));base64,/i);
  if (!mimeMatch) return 'image/jpeg';
  return mimeMatch[1].replace('image/jpg', 'image/jpeg').toLowerCase();
};


const extractFirebaseStoragePathFromUrl = (value) => {
  const text = String(value || '');
  if (!text.includes('firebasestorage.googleapis.com')) return '';
  const match = text.match(/\/o\/([^?]+)/);
  if (!match?.[1]) return '';
  try {
    return decodeURIComponent(match[1]);
  } catch (error) {
    return match[1];
  }
};

const resolveStoragePath = (storagePath, imageUri) => storagePath || extractFirebaseStoragePathFromUrl(imageUri);

const createFirebaseStorageDownloadUrl = (storagePath) => {
  const bucket = FIREBASE_CONFIG.storageBucket;
  const encodedPath = encodeURIComponent(storagePath);
  return `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/${encodedPath}?alt=media`;
};

/**
 * Uploads a data URI to Firebase Storage using Expo FileSystem native upload.
 * Important: do not use Firebase Storage SDK uploadString/uploadBytes here on
 * Android Expo, because those paths can still create ArrayBuffer/Blob objects
 * internally and trigger: "Creating blobs from ArrayBuffer are not supported".
 */
const uploadDataUriToFirebaseStorage = async ({ dataUri, folder, fileKey }) => {
  if (!isInlineImageDataUri(dataUri)) {
    return { imageUri: dataUri || '', storagePath: '' };
  }

  const idToken = await AuthService.getCurrentIdToken();
  if (!idToken) throw new Error('Firebase Storage upload requires a signed-in user.');

  const extension = getImageExtensionFromDataUri(dataUri);
  const storagePath = createStableStorageFilePath({ folder, fileKey, extension });
  const contentType = getContentTypeFromDataUri(dataUri);
  const temporaryFileUri = await writeDataUriToTemporaryFile({ dataUri, fileKey: `${fileKey}-upload` });

  const uploadUrl = `https://firebasestorage.googleapis.com/v0/b/${FIREBASE_CONFIG.storageBucket}/o?uploadType=media&name=${encodeURIComponent(storagePath)}`;

  const uploadRequest = async () => FileSystem.uploadAsync(uploadUrl, temporaryFileUri, {
    httpMethod: 'POST',
    // Use the legacy FileSystem API because uploadAsync was moved out of the main
    // expo-file-system export in newer Expo versions.
    uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
    headers: {
      Authorization: `Bearer ${idToken}`,
      'Content-Type': contentType,
      'Cache-Control': 'public,max-age=31536000'
    }
  });

  let response = await uploadRequest();
  if (response.status === 429) {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    response = await uploadRequest();
  }

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Firebase Storage upload failed (${response.status}): ${response.body || 'No response body'}`);
  }

  try {
    await FileSystem.deleteAsync(temporaryFileUri, { idempotent: true });
  } catch (error) {
    console.warn('StorageService Warning (temporary upload file cleanup skipped):', error);
  }

  return { imageUri: createFirebaseStorageDownloadUrl(storagePath), storagePath };
};

const deleteFirebaseStorageFileIfPossible = async (storagePath) => {
  if (!storagePath) return;

  try {
    const idToken = await AuthService.getCurrentIdToken();
    if (!idToken) {
      console.warn('StorageService Warning (delete storage image skipped): signed-in Firebase user token was not available.');
      return;
    }

    const deleteUrl = `https://firebasestorage.googleapis.com/v0/b/${FIREBASE_CONFIG.storageBucket}/o/${encodeURIComponent(storagePath)}`;
    const response = await fetch(deleteUrl, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${idToken}`
      }
    });

    // 404 means the old image is already gone. That should not block editing.
    if (response.status === 404) return;

    if (!response.ok) {
      const responseText = await response.text().catch(() => '');
      throw new Error(`Firebase Storage delete failed (${response.status}): ${responseText || 'No response body'}`);
    }
  } catch (error) {
    // Missing/locked images should never break catalog editing. The warning helps
    // owner/admin clean up any leftover Storage file later if needed.
    console.warn('StorageService Warning (delete storage image skipped):', error);
  }
};

const downloadRemoteImageToLocalCache = async ({ imageUri, fileKey, directoryUri }) => {
  if (!imageUri || !String(imageUri).startsWith('http')) return imageUri || '';
  if (!FileSystem.documentDirectory) return imageUri;

  try {
    await ensureDirectoryExists(LOCAL_IMAGE_CACHE_ROOT);
    await ensureDirectoryExists(directoryUri);
    const safeFileName = `${sanitizeImageFileName(fileKey)}.jpg`;
    const localUri = `${directoryUri}${safeFileName}`;
    const existing = await FileSystem.getInfoAsync(localUri);
    if (existing.exists && Number(existing.size || 0) > 0) return localUri;
    await FileSystem.downloadAsync(imageUri, localUri);
    return localUri;
  } catch (error) {
    console.warn('Image cache warning: could not download remote image to local cache.', error);
    return imageUri;
  }
};

const writeDataUriToTemporaryFile = async ({ dataUri, fileKey }) => {
  if (!isInlineImageDataUri(dataUri) || !FileSystem.cacheDirectory) return dataUri || '';

  const extension = getImageExtensionFromDataUri(dataUri);
  const base64Payload = getBase64PayloadFromDataUri(dataUri);
  const temporaryUri = `${FileSystem.cacheDirectory}${sanitizeImageFileName(fileKey)}-${Date.now()}.${extension}`;

  await FileSystem.writeAsStringAsync(temporaryUri, base64Payload, {
    encoding: FileSystem.EncodingType.Base64
  });

  return temporaryUri;
};

const createCatalogThumbnailDataUri = async ({ imageUri, fileKey }) => {
  if (!imageUri) return '';

  let localSourceUri = imageUri;

  if (isInlineImageDataUri(imageUri)) {
    localSourceUri = await writeDataUriToTemporaryFile({ dataUri: imageUri, fileKey });
  } else if (String(imageUri).startsWith('http')) {
    localSourceUri = await downloadRemoteImageToLocalCache({
      imageUri,
      fileKey: `${fileKey}-source`,
      directoryUri: CATALOG_IMAGE_CACHE_DIR
    });
  }

  const thumbnail = await ImageManipulator.manipulateAsync(
    localSourceUri,
    [{ resize: { width: 180 } }],
    { compress: 0.28, format: ImageManipulator.SaveFormat.JPEG, base64: true }
  );

  return `data:image/jpeg;base64,${thumbnail.base64}`;
};

const uploadCatalogImageAsThumbnail = async ({ imageUri, folder, fileKey }) => {
  if (!imageUri) return { imageUri: '', storagePath: '' };
  if (String(imageUri).startsWith('https://firebasestorage.googleapis.com') && String(imageUri).includes(CATALOG_STORAGE_FOLDER)) {
    return { imageUri, storagePath: extractFirebaseStoragePathFromUrl(imageUri) };
  }

  const thumbnailDataUri = await createCatalogThumbnailDataUri({ imageUri, fileKey });
  return uploadDataUriToFirebaseStorage({ dataUri: thumbnailDataUri, folder, fileKey });
};

const saveCatalogImagesToFirebaseStorage = async (material, uploadCache = new Map()) => {
  const normalized = normalizeMaterial(material);
  let imageUri = normalized.imageUri || '';
  let imageStoragePath = normalized.imageStoragePath || '';
  let groupCoverUri = normalized.groupCoverUri || '';
  let groupCoverStoragePath = normalized.groupCoverStoragePath || '';

  const uploadOnce = async ({ sourceUri, folder, fileKey }) => {
    const cacheKey = `${folder}/${fileKey}/${String(sourceUri).slice(0, 120)}`;
    if (uploadCache.has(cacheKey)) return uploadCache.get(cacheKey);
    const uploadPromise = uploadCatalogImageAsThumbnail({ imageUri: sourceUri, folder, fileKey });
    uploadCache.set(cacheKey, uploadPromise);
    return uploadPromise;
  };

  if (imageUri && (isInlineImageDataUri(imageUri) || String(imageUri).startsWith('file://') || String(imageUri).startsWith('content://'))) {
    const uploaded = await uploadOnce({
      sourceUri: imageUri,
      folder: CATALOG_STORAGE_FOLDER,
      fileKey: createMaterialImageStorageKey(normalized.id)
    });
    imageUri = uploaded.imageUri;
    imageStoragePath = uploaded.storagePath;
  }

  if (groupCoverUri && (isInlineImageDataUri(groupCoverUri) || String(groupCoverUri).startsWith('file://') || String(groupCoverUri).startsWith('content://'))) {
    const uploaded = await uploadOnce({
      sourceUri: groupCoverUri,
      folder: CATALOG_STORAGE_FOLDER,
      fileKey: createFamilyCoverStorageKey(normalized.familyName || normalized.id)
    });
    groupCoverUri = uploaded.imageUri;
    groupCoverStoragePath = uploaded.storagePath;
  }

  return {
    ...normalized,
    imageUri,
    imageStoragePath,
    groupCoverUri,
    groupCoverStoragePath
  };
};

const saveImportantInfoImageToFirebaseStorage = async (item) => {
  const normalized = normalizeImportantInfoItem(item);
  if (!isInlineImageDataUri(normalized.imageUri)) return normalized;

  if (normalized.imageStoragePath) {
    await deleteFirebaseStorageFileIfPossible(normalized.imageStoragePath);
  }

  const uploaded = await uploadDataUriToFirebaseStorage({
    dataUri: normalized.imageUri,
    folder: IMPORTANT_INFO_STORAGE_FOLDER,
    fileKey: createImportantInfoStorageKey(normalized.id)
  });

  return {
    ...normalized,
    imageUri: uploaded.imageUri,
    imageStoragePath: uploaded.storagePath
  };
};

const getRemoteCatalogUpdatedAt = async () => {
  try {
    const response = await fetch(CATALOG_META_ENDPOINT);
    if (!response.ok) return '';
    const metadata = await response.json();
    return metadata?.updatedAt || '';
  } catch (error) {
    console.warn('StorageService Warning (catalog metadata fetch skipped):', error);
    return '';
  }
};

const setRemoteCatalogUpdatedAt = async () => {
  try {
    const userLabel = await getCurrentAuditUserLabel();
    const metaUrl = await buildAuthenticatedFirebaseUrl(CATALOG_META_ENDPOINT);
    const now = new Date().toISOString();
    const response = await fetch(metaUrl, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ updatedAt: now, updatedBy: userLabel })
    });
    if (response.ok) await AsyncStorage.setItem(CATALOG_CLOUD_UPDATED_AT_KEY, now);
    return now;
  } catch (error) {
    console.warn('StorageService Warning (catalog metadata update skipped):', error);
    return '';
  }
};


const buildOptionalAuthenticatedFirebaseUrl = async (baseUrl, queryParameters = '') => {
  const idToken = await AuthService.getCurrentIdToken();
  const joiner = queryParameters ? '&' : '?';
  return `${baseUrl}${queryParameters || ''}${idToken ? `${joiner}auth=${encodeURIComponent(idToken)}` : ''}`;
};

const encodeFirebaseQueryStringValue = (value) => encodeURIComponent(JSON.stringify(value));

const buildFirebaseOrderedQueryUrl = async ({ endpointBase, orderByChild, startAt, limitToFirst }) => {
  const queryParts = [`orderBy=${encodeFirebaseQueryStringValue(orderByChild)}`];
  if (startAt) queryParts.push(`startAt=${encodeFirebaseQueryStringValue(startAt)}`);
  if (limitToFirst) queryParts.push(`limitToFirst=${Number(limitToFirst)}`);
  return await buildOptionalAuthenticatedFirebaseUrl(endpointBase, `?${queryParts.join('&')}`);
};

const setRemoteSettingsUpdatedAt = async () => {
  try {
    const userLabel = await getCurrentAuditUserLabel();
    const metaUrl = await buildAuthenticatedFirebaseUrl(SETTINGS_META_ENDPOINT);
    const now = new Date().toISOString();
    const response = await fetch(metaUrl, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ updatedAt: now, updatedBy: userLabel })
    });
    if (response.ok) await AsyncStorage.setItem(SETTINGS_CLOUD_UPDATED_AT_KEY, now);
    return now;
  } catch (error) {
    console.warn('StorageService Warning (settings metadata update skipped):', error);
    return '';
  }
};

const getRemoteSettingsUpdatedAt = async () => {
  try {
    const response = await fetch(SETTINGS_META_ENDPOINT);
    if (!response.ok) return '';
    const metadata = await response.json();
    return metadata?.updatedAt || '';
  } catch (error) {
    console.warn('StorageService Warning (settings metadata fetch skipped):', error);
    return '';
  }
};

/**
 * Saves a base64 data URI as a local image file and returns the file:// path.
 *
 * Firebase can still keep a compressed image payload for syncing between
 * devices, but SQLite should only cache lightweight references. This helper is
 * the bridge: when Firebase sends an inline image, the app writes it to the
 * device file system and stores only the resulting file path in SQLite.
 */
const saveInlineImageToLocalFile = async ({ dataUri, fileKey, directoryUri }) => {
  if (!isInlineImageDataUri(dataUri)) return dataUri || '';
  if (!FileSystem.documentDirectory) return dataUri;

  try {
    await ensureDirectoryExists(LOCAL_IMAGE_CACHE_ROOT);
    await ensureDirectoryExists(directoryUri);

    const extension = getImageExtensionFromDataUri(dataUri);
    const base64Data = String(dataUri).split('base64,')[1] || '';
    const safeFileName = `${sanitizeImageFileName(fileKey)}.${extension}`;
    const fileUri = `${directoryUri}${safeFileName}`;

    await FileSystem.writeAsStringAsync(fileUri, base64Data, {
      encoding: FileSystem.EncodingType.Base64
    });

    return fileUri;
  } catch (error) {
    console.warn('Image cache warning: could not write image to local file system.', error);
    return '';
  }
};

const prepareMaterialForLocalCache = async (material) => {
  const normalized = normalizeMaterial(material);

  if (isInlineImageDataUri(normalized.imageUri)) {
    const localImageUri = await saveInlineImageToLocalFile({
      dataUri: normalized.imageUri,
      fileKey: `${normalized.id}-${normalized.updatedAt || 'image'}`,
      directoryUri: CATALOG_IMAGE_CACHE_DIR
    });

    return {
      ...normalized,
      imageUri: localImageUri
    };
  }

  // Important optimization: do NOT download remote catalog images during sync.
  // Sync must only cache metadata. Images are downloaded lazily by CachedCatalogImage
  // only when the material is actually visible on screen. This prevents a single
  // catalog refresh from consuming hundreds of MB of Firebase bandwidth.
  return normalized;
};

const prepareImportantInfoForLocalCache = async (item) => {
  const normalized = normalizeImportantInfoItem(item);

  if (isInlineImageDataUri(normalized.imageUri)) {
    const localImageUri = await saveInlineImageToLocalFile({
      dataUri: normalized.imageUri,
      fileKey: `${normalized.id}-${normalized.updatedAt || 'image'}`,
      directoryUri: IMPORTANT_INFO_IMAGE_CACHE_DIR
    });

    return {
      ...normalized,
      imageUri: localImageUri
    };
  }

  if (String(normalized.imageUri || '').startsWith('http')) {
    const localImageUri = await downloadRemoteImageToLocalCache({
      imageUri: normalized.imageUri,
      fileKey: `${normalized.id}-${normalized.updatedAt || 'image'}`,
      directoryUri: IMPORTANT_INFO_IMAGE_CACHE_DIR
    });
    return { ...normalized, imageUri: localImageUri };
  }

  return normalized;
};

const normalizeMaterial = (material) => {
  const normalizedLegacyFields = extractLegacySizeFromName(material);

  let familyName = (material.familyName || material.groupName || '').trim();

  // If familyName is missing or just matches the full name, we try to detect
  // a wire family automatically based on the conductor color rules.
  if (!familyName || familyName.toLowerCase() === (normalizedLegacyFields.name || '').toLowerCase()) {
    if (isConductorColorFamily(material)) {
      familyName = getConductorFamilyDisplayName(material);
    } else {
      familyName = familyName || normalizedLegacyFields.name || 'Unnamed Material';
    }
  }

  return {
    id: material.id || createMaterialIdentifier(material),
    name: normalizedLegacyFields.name || 'Unnamed Material',
    familyName: familyName,
    category: material.category === 'Other' ? 'Others' : (material.category || 'Others'),
    size: normalizedLegacyFields.size || 'N/A',
    imageUri: material.imageUri || '',
    imageStoragePath: material.imageStoragePath || '',
    groupCoverUri: material.groupCoverUri || '',
    groupCoverStoragePath: material.groupCoverStoragePath || '',
    groupDescription: material.groupDescription || '',
    description: material.description || '',
    forceShowDescription: material.forceShowDescription === true,
    // Family-level UI preference used by CatalogScreen when opening a family
    // from Add Material to Quantity Sheet. Keep only the supported values so
    // older records safely default to square buttons.
    familyDisplayMode: material.familyDisplayMode === 'list' ? 'list' : 'grid',
    keywords: buildAutomaticKeywords(material, normalizedLegacyFields),
    allowedUnits: normalizeAllowedUnits(material.allowedUnits, material.category),
    createdAt: material.createdAt || new Date().toISOString(),
    updatedAt: material.updatedAt || new Date().toISOString(),
    requestCount: Number(material.requestCount || 0),
    lastRequestedAt: material.lastRequestedAt || '',
    deletedAt: material.deletedAt || '',
    version: Number(material.version || 1),
    createdBy: material.createdBy || FALLBACK_USER_LABEL,
    updatedBy: material.updatedBy || FALLBACK_USER_LABEL
  };
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

// Keeps the saved and cached catalog alphabetized by material family, then sorts
// every same-name family by real inch size in ascending order.
// Result example for EMT Conduit: 1/2", 3/4", 1", 1 1/8", 1 1/4", 1 1/2", 2"...
const sortCatalog = (catalog) => {
  return [...catalog].sort((a, b) => {
    const baseNameComparison = getSortableBaseName(a).localeCompare(getSortableBaseName(b));
    if (baseNameComparison !== 0) return baseNameComparison;

    const sizeComparison = getSortableSizeValue(a) - getSortableSizeValue(b);
    if (sizeComparison !== 0) return sizeComparison;

    return getMaterialDisplayName(a).localeCompare(getMaterialDisplayName(b));
  });
};


const normalizeImportantInfoItem = (item) => ({
  id: item.id || `info-${Date.now()}`,
  title: item.title || 'Untitled Info',
  body: item.body || '',
  imageUri: item.imageUri || '',
  imageStoragePath: item.imageStoragePath || '',
  createdAt: item.createdAt || new Date().toISOString(),
  updatedAt: item.updatedAt || new Date().toISOString(),
  createdBy: item.createdBy || FALLBACK_USER_LABEL,
  updatedBy: item.updatedBy || FALLBACK_USER_LABEL
});

const sortImportantInfo = (items) => [...items].sort((a, b) => a.title.localeCompare(b.title));

const convertFirebaseObjectToArray = (firebaseData) => {
  if (!firebaseData) return [];

  return Object.keys(firebaseData).map((key) => ({
    ...firebaseData[key],
    // The Firebase node key must be the internal id used by the app.
    // Some old records may contain a duplicated `id` field inside the object.
    // Placing `id: key` last prevents duplicate React keys and keeps the id hidden in the backend only.
    id: key
  }));
};

let sqliteDatabasePromise = null;
let sqliteDatabaseSetupPromise = null;
let sqliteWriteQueue = Promise.resolve();

/**
 * Runs SQLite write operations one after another.
 *
 * Expo SQLite can reject writes when two async calls try to open transactions at
 * the same time. The catalog can refresh from Firebase while the user is also
 * adding a material to the draft list, so this small queue prevents overlapping
 * cache writes without changing the rest of the app.
 */
const runSQLiteWriteSafely = async (operation) => {
  const queuedOperation = sqliteWriteQueue.then(operation, operation);

  sqliteWriteQueue = queuedOperation.catch(() => {
    // The queue should continue even if one cache write fails. Firebase and the
    // local draft are still the important data sources, so SQLite errors should
    // not block the app.
  });

  return queuedOperation;
};

/**
 * Opens the local SQLite database once and reuses the same connection.
 * SQLite is used only as a fast local cache. Firebase remains the shared source
 * of truth, but the app can show cached catalog data immediately while Firebase
 * refreshes in the background.
 */
const getSQLiteDatabase = async () => {
  if (!sqliteDatabasePromise) {
    sqliteDatabasePromise = SQLite.openDatabaseAsync(SQLITE_DATABASE_NAME);
  }

  const database = await sqliteDatabasePromise;

  if (!sqliteDatabaseSetupPromise) {
    sqliteDatabaseSetupPromise = database.execAsync(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS ${CATALOG_TABLE_NAME} (
        id TEXT PRIMARY KEY NOT NULL,
        data TEXT NOT NULL,
        updatedAt TEXT,
        deleted INTEGER DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS ${IMPORTANT_INFO_TABLE_NAME} (
        id TEXT PRIMARY KEY NOT NULL,
        data TEXT NOT NULL,
        updatedAt TEXT,
        deleted INTEGER DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS ${CABLE_CATALOG_TABLE_NAME} (
        id TEXT PRIMARY KEY NOT NULL,
        data TEXT NOT NULL,
        updatedAt TEXT,
        deleted INTEGER DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS ${CABLE_REQUIREMENT_TABLE_NAME} (
        id TEXT PRIMARY KEY NOT NULL,
        data TEXT NOT NULL,
        updatedAt TEXT
      );
    `);
  }

  await sqliteDatabaseSetupPromise;
  return database;
};

// Catalog photos can be very large when they are inline base64. SQLite should
// never store base64 image payloads, but it is safe and necessary to store
// lightweight Firebase Storage URLs/paths for every material. Earlier builds
// kept only the first image per family in the local cache. That saved a tiny
// amount of metadata, but it broke list-style families such as Bandsaw Blades:
// the individual material photo disappeared after saving/reloading because the
// cache blanked out imageUri for the second/third variant. Keep all remote/file
// references and only convert inline images to local files before SQLite writes.
const createFamilySharedImageCatalogCache = async (catalog) => {
  const preparedCatalog = [];

  for (const material of catalog || []) {
    const normalized = normalizeMaterial(material);
    preparedCatalog.push(await prepareMaterialForLocalCache(normalized));
  }

  return preparedCatalog;
};


const isLocalFileOrRemoteImageReference = (value) => {
  const text = String(value || '');
  return text.startsWith('file://') || text.startsWith('content://') || text.startsWith('http://') || text.startsWith('https://');
};

// SQLite should never receive base64 image payloads. It is a local index/cache,
// not an image store. Images should live in FileSystem or Firebase Storage, and
// the catalog row should keep only the image reference. This protects the app
// from SQLITE_FULL and CursorWindow row-size errors on Android.
const createCatalogCacheRecord = (material) => {
  const normalized = normalizeMaterial(material);
  return {
    ...normalized,
    imageUri: isLocalFileOrRemoteImageReference(normalized.imageUri) ? normalized.imageUri : '',
    imageStoragePath: normalized.imageStoragePath || '',
    groupCoverUri: isLocalFileOrRemoteImageReference(normalized.groupCoverUri) ? normalized.groupCoverUri : '',
    groupCoverStoragePath: normalized.groupCoverStoragePath || ''
  };
};

const isSQLiteFullOrCorruptCacheError = (error) => {
  const message = String(error?.message || error || '').toLowerCase();
  return message.includes('sqlite_full') || message.includes('database or disk is full') || message.includes('cursorwindow') || message.includes('row too big') || message.includes('nullpointerexception');
};

const resetCatalogSQLiteCache = async () => {
  try {
    const database = await getSQLiteDatabase();
    await database.execAsync(`
      DROP TABLE IF EXISTS ${CATALOG_TABLE_NAME};
      VACUUM;
      CREATE TABLE IF NOT EXISTS ${CATALOG_TABLE_NAME} (
        id TEXT PRIMARY KEY NOT NULL,
        data TEXT NOT NULL,
        updatedAt TEXT,
        deleted INTEGER DEFAULT 0
      );
    `);
  } catch (resetError) {
    console.warn('StorageService Warning (resetCatalogSQLiteCache skipped):', resetError);
  }
};

const ensureCatalogCacheSchema = async () => {
  try {
    const currentVersion = await AsyncStorage.getItem(CATALOG_CACHE_SCHEMA_KEY);
    if (currentVersion === CATALOG_CACHE_SCHEMA_VERSION) return;

    // Remove the old single-key AsyncStorage catalog because it can exceed the
    // Android row limit when the catalog grows. SQLite now stores one material
    // per row, and images are referenced instead of embedded.
    await AsyncStorage.multiRemove([CATALOG_CACHE_KEY]);
    await resetCatalogSQLiteCache();
    await AsyncStorage.setItem(CATALOG_CACHE_SCHEMA_KEY, CATALOG_CACHE_SCHEMA_VERSION);
  } catch (schemaError) {
    console.warn('StorageService Warning (ensureCatalogCacheSchema skipped):', schemaError);
  }
};

/**
 * Writes catalog rows into SQLite. Existing rows are replaced by id, which makes
 * the cache safe for repeated Firebase syncs and local edits.
 */
const saveCatalogToSQLite = async (catalog) => {
  const familySharedCatalog = await createFamilySharedImageCatalogCache(catalog);
  const cacheCatalog = familySharedCatalog.map(createCatalogCacheRecord);

  await runSQLiteWriteSafely(async () => {
    const database = await getSQLiteDatabase();

    // This cache must mirror Firebase exactly after every cloud refresh.
    // Older versions only inserted/replaced rows, so hard-deleted Firebase
    // materials stayed visible on the device forever. Clearing first makes
    // pull-to-refresh and background sync remove deleted cloud records too.
    await database.runAsync(`DELETE FROM ${CATALOG_TABLE_NAME};`);

    // Explicitly reclaim space if we just performed a large delete.
    // This solves the SQLITE_FULL error by returning unused pages to the OS.
    await database.runAsync(`VACUUM;`);

    // Avoid withTransactionAsync here. On some Expo SQLite versions, a background
    // Firebase sync and a foreground user action can overlap and produce:
    // "cannot start a transaction within a transaction". Sequential runAsync
    // calls are slower than one transaction, but they are much safer for this
    // cache layer and they do not block the requisition workflow.
    for (const material of cacheCatalog || []) {
      const normalized = createCatalogCacheRecord(material);
      await database.runAsync(
        `INSERT OR REPLACE INTO ${CATALOG_TABLE_NAME} (id, data, updatedAt, deleted) VALUES (?, ?, ?, ?);`,
        [normalized.id, JSON.stringify(normalized), normalized.updatedAt || '', 0]
      );
    }
  });
};


/**
 * Merges only changed catalog rows into SQLite. This is used by normal app
 * startup/focus so a device does not download and rewrite the whole catalog
 * when Firebase only changed one material.
 */
const mergeCatalogChangesIntoSQLite = async (catalogChanges = []) => {
  const activeChanges = (catalogChanges || [])
    .map(normalizeMaterial)
    .filter((material) => !material.deletedAt);
  const cacheCatalog = (await createFamilySharedImageCatalogCache(activeChanges)).map(createCatalogCacheRecord);

  await runSQLiteWriteSafely(async () => {
    const database = await getSQLiteDatabase();
    for (const material of cacheCatalog) {
      const normalized = createCatalogCacheRecord(material);
      await database.runAsync(
        `INSERT OR REPLACE INTO ${CATALOG_TABLE_NAME} (id, data, updatedAt, deleted) VALUES (?, ?, ?, ?);`,
        [normalized.id, JSON.stringify(normalized), normalized.updatedAt || '', 0]
      );
    }
  });
};

const removeCatalogRowsFromSQLite = async (materialIds = []) => {
  const ids = [...new Set((materialIds || []).filter(Boolean))];
  if (ids.length === 0) return;
  await runSQLiteWriteSafely(async () => {
    const database = await getSQLiteDatabase();
    for (const id of ids) {
      await database.runAsync(`DELETE FROM ${CATALOG_TABLE_NAME} WHERE id = ?;`, [id]);
    }
    // Keep the local cache small after batches of owner deletes.
    if (ids.length > 10) await database.runAsync(`VACUUM;`);
  });
};

/**
 * Reads catalog rows from SQLite and hides soft-deleted records from normal UI.
 */
const loadCatalogFromSQLite = async () => {
  const database = await getSQLiteDatabase();
  const rows = await database.getAllAsync(`SELECT data FROM ${CATALOG_TABLE_NAME} WHERE deleted = 0;`);
  return sortCatalog(rows.map((row) => normalizeMaterial(JSON.parse(row.data))).filter((material) => !material.deletedAt));
};

/**
 * Removes one catalog row from the visible SQLite cache without touching
 * Firebase. Firebase still keeps soft-deleted records for recovery.
 */
const removeCatalogRowFromSQLite = async (materialId) => {
  await runSQLiteWriteSafely(async () => {
    const database = await getSQLiteDatabase();
    await database.runAsync(`DELETE FROM ${CATALOG_TABLE_NAME} WHERE id = ?;`, [materialId]);
  });
};

const saveImportantInfoToSQLite = async (items) => {
  await runSQLiteWriteSafely(async () => {
    const database = await getSQLiteDatabase();

    // Same reason as the catalog cache: Important Info can refresh while the
    // user is editing a card, so writes are queued and executed without nested
    // transactions.
    for (const item of items || []) {
      const normalized = normalizeImportantInfoItem(item);
      await database.runAsync(
        `INSERT OR REPLACE INTO ${IMPORTANT_INFO_TABLE_NAME} (id, data, updatedAt, deleted) VALUES (?, ?, ?, ?);`,
        [normalized.id, JSON.stringify(normalized), normalized.updatedAt || '', 0]
      );
    }
  });
};

const loadImportantInfoFromSQLite = async () => {
  const database = await getSQLiteDatabase();
  const rows = await database.getAllAsync(`SELECT data FROM ${IMPORTANT_INFO_TABLE_NAME};`);
  return sortImportantInfo(rows.map((row) => normalizeImportantInfoItem(JSON.parse(row.data))));
};

const removeImportantInfoRowFromSQLite = async (itemId) => {
  await runSQLiteWriteSafely(async () => {
    const database = await getSQLiteDatabase();
    await database.runAsync(`DELETE FROM ${IMPORTANT_INFO_TABLE_NAME} WHERE id = ?;`, [itemId]);
  });
};


const getCatalogImageLocalCacheUri = async ({ imageUri, materialId, updatedAt }) => {
  return downloadRemoteImageToLocalCache({
    imageUri,
    fileKey: `${materialId || 'catalog-image'}-${updatedAt || 'image'}`,
    directoryUri: CATALOG_IMAGE_CACHE_DIR
  });
};

const clearDirectoryIfPossible = async (directoryUri) => {
  try {
    const info = await FileSystem.getInfoAsync(directoryUri);
    if (info.exists) await FileSystem.deleteAsync(directoryUri, { idempotent: true });
    await ensureDirectoryExists(directoryUri);
  } catch (error) {
    console.warn('StorageService Warning (clear image cache skipped):', error);
  }
};



export const StorageService = {
  /**
   * Lazily resolves a catalog thumbnail into a local file URI. Use this only
   * from visible UI rows. It avoids downloading every image during catalog sync.
   */
  async getCatalogThumbnailForDisplay(material) {
    const normalized = normalizeMaterial(material || {});
    return getCatalogImageLocalCacheUri({
      imageUri: normalized.imageUri || normalized.groupCoverUri || '',
      materialId: normalized.id,
      updatedAt: normalized.updatedAt
    });
  },

  /**
   * Owner/debug maintenance helper. Clears only local thumbnail cache; Firebase
   * images remain safe. Useful after replacing many catalog images.
   */
  async clearLocalCatalogImageCache() {
    await clearDirectoryIfPossible(CATALOG_IMAGE_CACHE_DIR);
    return true;
  },

  /**
   * Saves project draft locally. The requisition stays local and independent from catalog images.
   */
  async saveDraft(projectData) {
    try {
      if (!projectData) return;
      const jsonValue = JSON.stringify(projectData);
      const draftKey = createDraftStorageKey(projectData.creatorSessionKey);
      await AsyncStorage.setItem(draftKey, jsonValue);
    } catch (e) {
      console.error('StorageService Error (saveDraft):', e);
    }
  },

  /**
   * Loads project draft from local storage.
   */
  async loadDraft(sessionKey = '') {
    const draftKey = createDraftStorageKey(sessionKey);

    try {
      const jsonValue = await AsyncStorage.getItem(draftKey);
      if (jsonValue !== null) {
        return JSON.parse(jsonValue);
      }

      // Remove the old shared draft key if it exists. Older versions used one
      // shared local draft for every account, which could make a new user see a
      // previous user's requisition. From now on every registered user has a
      // separate draft key based on their own uid/email, and guests use a
      // temporary guest key.
      await AsyncStorage.removeItem(DRAFT_KEY);

      return null;
    } catch (e) {
      console.error('StorageService Error (loadDraft):', e);
      await AsyncStorage.removeItem(draftKey);
      return null;
    }
  },

  async clearDraft(sessionKey = '') {
    try {
      await AsyncStorage.removeItem(createDraftStorageKey(sessionKey));
    } catch (e) {
      console.error('StorageService Error (clearDraft):', e);
    }
  },

  async clearGuestDraft() {
    try {
      await AsyncStorage.removeItem(GUEST_DRAFT_KEY);
    } catch (e) {
      console.error('StorageService Error (clearGuestDraft):', e);
    }
  },

  /**
   * Saves a local catalog cache. This is only a backup if Firebase is temporarily unavailable.
   */
  async saveCatalogCache(catalog) {
    try {
      await ensureCatalogCacheSchema();
      const sortedCatalog = sortCatalog((catalog || []).map(normalizeMaterial));

      // Do not keep a second full copy of the catalog in AsyncStorage. Android
      // stores AsyncStorage in SQLite too, and one huge JSON row can trigger
      // CursorWindow and SQLITE_FULL errors. The only local catalog cache is now
      // the row-based SQLite table.
      await AsyncStorage.removeItem(CATALOG_CACHE_KEY);
      await saveCatalogToSQLite(sortedCatalog);
    } catch (e) {
      if (isSQLiteFullOrCorruptCacheError(e)) {
        console.warn('StorageService Warning (catalog cache reset after storage pressure):', e);
        await resetCatalogSQLiteCache();
        return;
      }
      console.warn('StorageService Warning (saveCatalogCache skipped):', e);
    }
  },

  /**
   * Loads the local catalog cache.
   */
  async loadCatalogCache() {
    try {
      await ensureCatalogCacheSchema();
      const sqliteCatalog = await loadCatalogFromSQLite();
      return sqliteCatalog.length > 0 ? sqliteCatalog : [];
    } catch (sqliteError) {
      if (isSQLiteFullOrCorruptCacheError(sqliteError)) {
        console.warn('StorageService Warning (catalog cache reset after load failure):', sqliteError);
        await resetCatalogSQLiteCache();
      } else {
        console.error('StorageService Error (loadCatalogCache SQLite):', sqliteError);
      }
      return [];
    }
  },

  /**
   * Pulls the newest catalog from Firebase and updates SQLite. This method is
   * intentionally separated from loadCatalog so the UI can open quickly from
   * local data while a cloud refresh runs in the background.
   */
  async syncCatalogFromFirebase() {
    const materialsUrl = await buildOptionalAuthenticatedFirebaseUrl(MATERIALS_ENDPOINT);
    const response = await fetch(materialsUrl);

    if (!response.ok) {
      throw new Error(`Firebase load failed: ${response.status}`);
    }

    const firebaseData = await response.json();
    let catalog = convertFirebaseObjectToArray(firebaseData).map(normalizeMaterial);

    if (catalog.length === 0) {
      catalog = await this.seedInitialCatalog();
    }

    catalog = sortCatalog(catalog);
    await this.saveCatalogCache(catalog);
    const newestUpdatedAt = catalog.reduce((latest, material) => String(material.updatedAt || '') > latest ? String(material.updatedAt || '') : latest, '');
    if (newestUpdatedAt) await AsyncStorage.setItem(CATALOG_LAST_INCREMENTAL_SYNC_AT_KEY, newestUpdatedAt);
    return catalog;
  },

  /**
   * Reads the material catalog from local SQLite first so the catalog opens
   * quickly and does not contact Firebase on every screen focus. If local data
   * exists, Firebase refreshes in the background. If local data is empty, the
   * method waits for Firebase once and seeds the starter catalog if needed.
   */
  async loadCatalog() {
    const cachedCatalog = await this.loadCatalogCache();

    if (cachedCatalog.length > 0) {
      // Only check a tiny metadata node on open/focus. If the cloud timestamp
      // has not changed, the app stays fully local and does not re-download the
      // full catalog or image URLs.
      this.syncCatalogIfChanged().catch((error) => {
        console.error('StorageService Background Catalog Metadata Sync Error:', error);
      });
      return cachedCatalog;
    }

    try {
      return await this.syncCatalogFromFirebase();
    } catch (e) {
      console.error('StorageService Error (loadCatalog Firebase):', e);
      const starterCatalog = sortCatalog(initialCatalog.map(normalizeMaterial));
      await this.saveCatalogCache(starterCatalog);
      return starterCatalog;
    }
  },

  async syncCatalogIfChanged() {
    const remoteUpdatedAt = await getRemoteCatalogUpdatedAt();
    const localUpdatedAt = await AsyncStorage.getItem(CATALOG_CLOUD_UPDATED_AT_KEY);

    if (remoteUpdatedAt && localUpdatedAt && remoteUpdatedAt === localUpdatedAt) {
      return await this.loadCatalogCache();
    }

    const lastIncrementalSyncAt = await AsyncStorage.getItem(CATALOG_LAST_INCREMENTAL_SYNC_AT_KEY);
    if (!lastIncrementalSyncAt) {
      const fullCatalog = await this.syncCatalogFromFirebase();
      if (remoteUpdatedAt) await AsyncStorage.setItem(CATALOG_CLOUD_UPDATED_AT_KEY, remoteUpdatedAt);
      return fullCatalog;
    }

    const changesUrl = await buildFirebaseOrderedQueryUrl({
      endpointBase: MATERIALS_ENDPOINT,
      orderByChild: 'updatedAt',
      startAt: lastIncrementalSyncAt
    });
    const changesResponse = await fetch(changesUrl);
    if (!changesResponse.ok) {
      throw new Error(`Firebase incremental catalog sync failed: ${changesResponse.status}`);
    }

    const changesData = await changesResponse.json();
    const changedCatalog = convertFirebaseObjectToArray(changesData)
      .map(normalizeMaterial)
      .filter((material) => String(material.updatedAt || '') > String(lastIncrementalSyncAt || ''));

    await mergeCatalogChangesIntoSQLite(changedCatalog);

    const deletedUrl = await buildFirebaseOrderedQueryUrl({
      endpointBase: CATALOG_DELETED_ENDPOINT,
      orderByChild: 'deletedAt',
      startAt: lastIncrementalSyncAt
    });
    const deletedResponse = await fetch(deletedUrl);
    if (deletedResponse.ok) {
      const deletedData = await deletedResponse.json();
      const deletedIds = convertFirebaseObjectToArray(deletedData)
        .filter((record) => String(record.deletedAt || '') > String(lastIncrementalSyncAt || ''))
        .map((record) => record.id)
        .filter(Boolean);
      await removeCatalogRowsFromSQLite(deletedIds);
    }

    const newestChangedAt = changedCatalog.reduce((latest, material) => String(material.updatedAt || '') > latest ? String(material.updatedAt || '') : latest, lastIncrementalSyncAt);
    const nextSyncAt = remoteUpdatedAt || newestChangedAt || new Date().toISOString();
    await AsyncStorage.multiSet([
      [CATALOG_LAST_INCREMENTAL_SYNC_AT_KEY, nextSyncAt],
      [CATALOG_CLOUD_UPDATED_AT_KEY, remoteUpdatedAt || nextSyncAt]
    ]);
    return await this.loadCatalogCache();
  },


  /**
   * One-time owner maintenance tool. It converts old base64 catalog images that
   * are still stored inside Realtime Database into Firebase Storage thumbnails.
   * Run this after upgrading so future catalog reads download tiny JSON records
   * instead of large embedded images.
   */
  async migrateCatalogInlineImagesToStorageThumbnails() {
    await ensureSharedDataEditor();
    const catalog = await this.syncCatalogFromFirebase();
    const firebasePatch = {};
    let migratedCount = 0;

    for (const material of catalog) {
      const normalized = normalizeMaterial(material);
      const needsImageOptimization = Boolean(
        normalized.imageUri && (
          isInlineImageDataUri(normalized.imageUri) ||
          String(normalized.imageUri).startsWith('file://') ||
          String(normalized.imageUri).startsWith('content://') ||
          (String(normalized.imageUri).startsWith('http') && !String(normalized.imageUri).includes(CATALOG_STORAGE_FOLDER))
        )
      );
      const needsCoverOptimization = Boolean(
        normalized.groupCoverUri && (
          isInlineImageDataUri(normalized.groupCoverUri) ||
          String(normalized.groupCoverUri).startsWith('file://') ||
          String(normalized.groupCoverUri).startsWith('content://') ||
          (String(normalized.groupCoverUri).startsWith('http') && !String(normalized.groupCoverUri).includes(CATALOG_STORAGE_FOLDER))
        )
      );

      if (!needsImageOptimization && !needsCoverOptimization) continue;

      let updatedMaterial = { ...normalized };

      if (needsImageOptimization) {
        const uploaded = await uploadCatalogImageAsThumbnail({
          imageUri: normalized.imageUri,
          folder: CATALOG_STORAGE_FOLDER,
          fileKey: createMaterialImageStorageKey(normalized.id)
        });
        updatedMaterial.imageUri = uploaded.imageUri;
        updatedMaterial.imageStoragePath = uploaded.storagePath;
      }

      if (needsCoverOptimization) {
        const uploaded = await uploadCatalogImageAsThumbnail({
          imageUri: normalized.groupCoverUri,
          folder: CATALOG_STORAGE_FOLDER,
          fileKey: createFamilyCoverStorageKey(normalized.familyName || normalized.id)
        });
        updatedMaterial.groupCoverUri = uploaded.imageUri;
        updatedMaterial.groupCoverStoragePath = uploaded.storagePath;
      }

      updatedMaterial.updatedAt = new Date().toISOString();
      firebasePatch[updatedMaterial.id] = updatedMaterial;
      migratedCount += 1;
    }

    if (migratedCount === 0) return 0;

    const materialsUrl = await buildAuthenticatedFirebaseUrl(`${FIREBASE_DATABASE_URL}/materials.json`);
    const response = await fetch(materialsUrl, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(firebasePatch)
    });

    if (!response.ok) throw new Error(`Firebase thumbnail migration failed: ${response.status}`);
    await setRemoteCatalogUpdatedAt();
    await this.syncCatalogFromFirebase();
    return migratedCount;
  },

  /**
   * Adds one material to Firebase without replacing the full catalog.
   */
  async addMaterial(material) {
    try {
      await ensureSharedDataEditor();
      const now = new Date().toISOString();
      const userLabel = await getCurrentAuditUserLabel();
      let preparedMaterial = normalizeMaterial({
        ...material,
        createdAt: material.createdAt || now,
        updatedAt: now,
        createdBy: material.createdBy || userLabel,
        version: Number(material.version || 1),
        updatedBy: userLabel
      });

      // Use the current local cache for duplicate checks so this write does not
      // trigger a background Firebase sync that can overwrite the newly added
      // material before the UI refreshes. If the cache is empty, sync once.
      let existingCatalog = await this.loadCatalogCache();
      if (existingCatalog.length === 0) {
        try {
          existingCatalog = await this.syncCatalogFromFirebase();
        } catch (syncError) {
          console.warn('StorageService Warning (addMaterial duplicate sync skipped):', syncError);
          existingCatalog = [];
        }
      }

      const exists = existingCatalog.some(
        (item) => item.name.toLowerCase() === preparedMaterial.name.toLowerCase() && (item.size || 'N/A').toLowerCase() === (preparedMaterial.size || 'N/A').toLowerCase()
      );

      if (exists) {
        throw new Error('DUPLICATE_MATERIAL');
      }

      preparedMaterial = await saveCatalogImagesToFirebaseStorage(preparedMaterial);

      const materialUrl = await buildAuthenticatedFirebaseUrl(`${FIREBASE_DATABASE_URL}/materials/${preparedMaterial.id}.json`);
      const response = await fetch(materialUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(preparedMaterial)
      });

      if (!response.ok) {
        throw new Error(`Firebase save failed: ${response.status}`);
      }

      await setRemoteCatalogUpdatedAt();
      const updatedCatalog = sortCatalog([...existingCatalog, preparedMaterial]);
      await this.saveCatalogCache(updatedCatalog);
      return preparedMaterial;
    } catch (e) {
      console.error('StorageService Error (addMaterial):', e);
      throw e;
    }
  },


  /**
   * Updates a whole material family in one Firebase multi-location PATCH.
   * A family is a repeated material with the same base name but different sizes,
   * such as EMT Pipe 1/2", 3/4", 1", etc. The UI sends all family variants here
   * so one shared image, name, category, description, and unit set can be applied
   * consistently without editing every size one by one.
   */
  async updateMaterialFamily(materialVariants) {
    try {
      await ensureSharedDataEditor();
      if (!Array.isArray(materialVariants) || materialVariants.length === 0) {
        throw new Error('MISSING_MATERIAL_FAMILY');
      }

      const existingCatalog = await this.loadCatalog();
      const userLabel = await getCurrentAuditUserLabel();
      const now = new Date().toISOString();

      const existingByIdForVersion = new Map(existingCatalog.map((item) => [item.id, item]));
      let normalizedUpdates = materialVariants.map((variant) => {
        const previousVariant = existingByIdForVersion.get(variant.id) || {};
        return normalizeMaterial({
          ...previousVariant,
          ...variant,
          id: variant.id,
          name: (variant.name || previousVariant.name || '').trim(),
          category: variant.category || previousVariant.category || 'Others',
          size: variant.size || previousVariant.size || 'N/A',
          imageUri: variant.imageUri !== undefined ? variant.imageUri : (previousVariant.imageUri || ''),
          imageStoragePath: variant.imageStoragePath !== undefined ? variant.imageStoragePath : (previousVariant.imageStoragePath || ''),
          groupCoverUri: variant.groupCoverUri !== undefined ? variant.groupCoverUri : (previousVariant.groupCoverUri || ''),
          groupCoverStoragePath: variant.groupCoverStoragePath !== undefined ? variant.groupCoverStoragePath : (previousVariant.groupCoverStoragePath || ''),
          description: variant.description !== undefined ? variant.description : (previousVariant.description || ''),
          allowedUnits: normalizeAllowedUnits(variant.allowedUnits || previousVariant.allowedUnits, variant.category || previousVariant.category),
          createdAt: previousVariant.createdAt || variant.createdAt || now,
          createdBy: previousVariant.createdBy || variant.createdBy || userLabel,
          updatedAt: now,
          version: Number(previousVariant.version || variant.version || 1) + 1,
          updatedBy: userLabel
        });
      });

      {
        const familyUploadCache = new Map();
        const preparedUpdates = [];
        for (const item of normalizedUpdates) {
          preparedUpdates.push(await saveCatalogImagesToFirebaseStorage(item, familyUploadCache));
        }
        normalizedUpdates = preparedUpdates;
      }

      const idsBeingUpdated = new Set(normalizedUpdates.map((item) => item.id));
      const duplicate = existingCatalog.some((existingItem) => {
        if (idsBeingUpdated.has(existingItem.id)) return false;
        return normalizedUpdates.some((updatedItem) =>
          existingItem.name.toLowerCase() === updatedItem.name.toLowerCase() &&
          (existingItem.size || 'N/A').toLowerCase() === (updatedItem.size || 'N/A').toLowerCase()
        );
      });

      if (duplicate) {
        throw new Error('DUPLICATE_MATERIAL');
      }

      const existingById = new Map(existingCatalog.map((item) => [item.id, item]));
      for (const updatedMaterial of normalizedUpdates) {
        const existingMaterial = existingById.get(updatedMaterial.id) || {};
        const oldCatalogImagePath = resolveStoragePath(existingMaterial.imageStoragePath, existingMaterial.imageUri);
        const newCatalogImagePath = resolveStoragePath(updatedMaterial.imageStoragePath, updatedMaterial.imageUri);
        const oldCoverImagePath = resolveStoragePath(existingMaterial.groupCoverStoragePath, existingMaterial.groupCoverUri);
        const newCoverImagePath = resolveStoragePath(updatedMaterial.groupCoverStoragePath, updatedMaterial.groupCoverUri);

        if (oldCatalogImagePath && oldCatalogImagePath !== newCatalogImagePath) {
          await deleteFirebaseStorageFileIfPossible(oldCatalogImagePath);
        }

        if (oldCoverImagePath && oldCoverImagePath !== newCoverImagePath) {
          await deleteFirebaseStorageFileIfPossible(oldCoverImagePath);
        }
      }

      const firebasePatch = {};
      normalizedUpdates.forEach((material) => {
        firebasePatch[material.id] = material;
      });

      const materialsUrl = await buildAuthenticatedFirebaseUrl(`${FIREBASE_DATABASE_URL}/materials.json`);
      const response = await fetch(materialsUrl, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(firebasePatch)
      });

      if (!response.ok) {
        throw new Error(`Firebase material family update failed: ${response.status}`);
      }

      await setRemoteCatalogUpdatedAt();
      const updateMap = new Map(normalizedUpdates.map((item) => [item.id, item]));
      const updatedCatalog = sortCatalog(existingCatalog.map((item) => updateMap.get(item.id) || item));
      await this.saveCatalogCache(updatedCatalog);
      return normalizedUpdates;
    } catch (e) {
      console.error('StorageService Error (updateMaterialFamily):', e);
      throw e;
    }
  },


  /**
   * Updates editable catalog details for an existing material in Firebase.
   * This edits the catalog record only. Existing requisition rows are not changed automatically.
   */
  async updateMaterial(materialId, materialChanges) {
    try {
      await ensureSharedDataEditor();
      if (!materialId) {
        throw new Error('MISSING_MATERIAL_ID');
      }

      const cleanName = materialChanges.name?.trim();
      if (!cleanName) {
        throw new Error('MISSING_MATERIAL_NAME');
      }

      const existingCatalog = await this.loadCatalog();
      const duplicate = existingCatalog.some((item) =>
        item.id !== materialId && item.name.toLowerCase() === cleanName.toLowerCase() && (item.size || 'N/A').toLowerCase() === (materialChanges.size || 'N/A').toLowerCase()
      );

      if (duplicate) {
        throw new Error('DUPLICATE_MATERIAL');
      }

      const userLabel = await getCurrentAuditUserLabel();
      const existingMaterial = existingCatalog.find((item) => item.id === materialId) || {};
      let updatedMaterial = normalizeMaterial({
        ...existingMaterial,
        ...materialChanges,
        id: materialId,
        name: cleanName,
        category: materialChanges.category || existingMaterial.category || 'Others',
        size: materialChanges.size || existingMaterial.size || 'N/A',
        imageUri: materialChanges.imageUri !== undefined ? materialChanges.imageUri : (existingMaterial.imageUri || ''),
        imageStoragePath: materialChanges.imageStoragePath !== undefined ? materialChanges.imageStoragePath : (existingMaterial.imageStoragePath || ''),
        groupCoverUri: materialChanges.groupCoverUri !== undefined ? materialChanges.groupCoverUri : (existingMaterial.groupCoverUri || ''),
        groupCoverStoragePath: materialChanges.groupCoverStoragePath !== undefined ? materialChanges.groupCoverStoragePath : (existingMaterial.groupCoverStoragePath || ''),
        description: materialChanges.description !== undefined ? materialChanges.description : (existingMaterial.description || ''),
        allowedUnits: normalizeAllowedUnits(materialChanges.allowedUnits || existingMaterial.allowedUnits, materialChanges.category || existingMaterial.category),
        createdAt: existingMaterial.createdAt || materialChanges.createdAt || new Date().toISOString(),
        createdBy: existingMaterial.createdBy || materialChanges.createdBy || userLabel,
        updatedAt: new Date().toISOString(),
        version: Number(existingMaterial.version || materialChanges.version || 1) + 1,
        updatedBy: userLabel
      });

      updatedMaterial = await saveCatalogImagesToFirebaseStorage(updatedMaterial);

      const oldCatalogImagePath = resolveStoragePath(existingMaterial.imageStoragePath, existingMaterial.imageUri);
      const oldCoverImagePath = resolveStoragePath(existingMaterial.groupCoverStoragePath, existingMaterial.groupCoverUri);
      const imageWasRemovedOrReplaced = oldCatalogImagePath && oldCatalogImagePath !== resolveStoragePath(updatedMaterial.imageStoragePath, updatedMaterial.imageUri);
      const coverWasRemovedOrReplaced = oldCoverImagePath && oldCoverImagePath !== resolveStoragePath(updatedMaterial.groupCoverStoragePath, updatedMaterial.groupCoverUri);

      if (imageWasRemovedOrReplaced) {
        await deleteFirebaseStorageFileIfPossible(oldCatalogImagePath);
      }

      if (coverWasRemovedOrReplaced) {
        await deleteFirebaseStorageFileIfPossible(oldCoverImagePath);
      }

      const materialUrl = await buildAuthenticatedFirebaseUrl(`${FIREBASE_DATABASE_URL}/materials/${materialId}.json`);
      const response = await fetch(materialUrl, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updatedMaterial)
      });

      if (!response.ok) {
        throw new Error(`Firebase material update failed: ${response.status}`);
      }

      await setRemoteCatalogUpdatedAt();

      const updatedCatalog = sortCatalog(
        existingCatalog.map((item) => (item.id === materialId ? updatedMaterial : item))
      );

      await this.saveCatalogCache(updatedCatalog);
      return updatedMaterial;
    } catch (e) {
      console.error('StorageService Error (updateMaterial):', e);
      throw e;
    }
  },


  /**
   * Updates only the catalog image for an existing material in Firebase.
   * This keeps the requisition/draft list independent from catalog photos.
   */
  async updateMaterialImage(materialId, imageUri) {
    try {
      await ensureSharedDataEditor();
      if (!materialId) {
        throw new Error('MISSING_MATERIAL_ID');
      }

      const userLabel = await getCurrentAuditUserLabel();
      const now = new Date().toISOString();
      const existingCatalog = await this.loadCatalogCache();
      const existingMaterial = existingCatalog.find((item) => item.id === materialId) || {};
      const oldImageStoragePath = resolveStoragePath(existingMaterial.imageStoragePath, existingMaterial.imageUri);
      const cleanImageUri = imageUri || '';

      let finalImageUri = '';
      let finalImageStoragePath = '';

      if (cleanImageUri) {
        const uploadResult = await uploadCatalogImageAsThumbnail({
          imageUri: cleanImageUri,
          folder: CATALOG_STORAGE_FOLDER,
          fileKey: createMaterialImageStorageKey(materialId)
        });
        finalImageUri = uploadResult.imageUri || cleanImageUri;
        finalImageStoragePath = uploadResult.storagePath || '';
      }

      if (oldImageStoragePath && oldImageStoragePath !== finalImageStoragePath) {
        await deleteFirebaseStorageFileIfPossible(oldImageStoragePath);
      }

      const materialUrl = await buildAuthenticatedFirebaseUrl(`${FIREBASE_DATABASE_URL}/materials/${materialId}.json`);
      const response = await fetch(materialUrl, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          imageUri: finalImageUri,
          imageStoragePath: finalImageStoragePath,
          updatedAt: now,
          updatedBy: userLabel
        })
      });

      if (!response.ok) {
        throw new Error(`Firebase image update failed: ${response.status}`);
      }

      await setRemoteCatalogUpdatedAt();
      const updatedCatalog = existingCatalog.map((item) => (
        item.id === materialId
          ? { ...item, imageUri: finalImageUri, imageStoragePath: finalImageStoragePath, updatedAt: now, updatedBy: userLabel }
          : item
      ));
      await this.saveCatalogCache(updatedCatalog);
      return true;
    } catch (e) {
      console.error('StorageService Error (updateMaterialImage):', e);
      throw e;
    }
  },

  /**
   * Seeds Firebase with the starter catalog only when the cloud catalog is empty.
   */
  async seedInitialCatalog() {
    const preparedCatalog = initialCatalog.map(normalizeMaterial);
    const firebaseObject = preparedCatalog.reduce((accumulator, material) => {
      accumulator[material.id] = material;
      return accumulator;
    }, {});

    const materialsUrl = await buildAuthenticatedFirebaseUrl(MATERIALS_ENDPOINT);
    const response = await fetch(materialsUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(firebaseObject)
    });

    if (!response.ok) {
      throw new Error(`Firebase seed failed: ${response.status}`);
    }

    await setRemoteCatalogUpdatedAt();
    await this.saveCatalogCache(preparedCatalog);
    return preparedCatalog;
  },

  /**
   * Backward-compatible method name. It now merges catalog records instead of overwriting the full Firebase catalog. This prevents accidental deletion of existing Firebase materials.
   */
  async saveCatalog(catalog) {
    try {
      const preparedCatalog = catalog.map(normalizeMaterial);
      const firebaseObject = preparedCatalog.reduce((accumulator, material) => {
        accumulator[material.id] = material;
        return accumulator;
      }, {});

      const materialsUrl = await buildAuthenticatedFirebaseUrl(MATERIALS_ENDPOINT);
      const response = await fetch(materialsUrl, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(firebaseObject)
      });

      if (!response.ok) {
        throw new Error(`Firebase saveCatalog failed: ${response.status}`);
      }

      await setRemoteCatalogUpdatedAt();
      const existingCatalog = await this.loadCatalogCache();
      const mergedById = [...existingCatalog, ...preparedCatalog].reduce((accumulator, material) => {
        accumulator[material.id] = material;
        return accumulator;
      }, {});
      await this.saveCatalogCache(sortCatalog(Object.values(mergedById)));
    } catch (e) {
      console.error('StorageService Error (saveCatalog):', e);
      throw e;
    }
  },


  /**
   * Increments the request counter for catalog materials after they are added
   * to the requisition. The counter is used by the catalog sort menu so the
   * most frequently requested materials can appear first when that option is selected.
   */
  async incrementMaterialRequestCount(materialIds = []) {
    try {
      const uniqueIds = [...new Set((materialIds || []).filter(Boolean))];
      if (uniqueIds.length === 0) return true;

      const catalog = await this.loadCatalog();
      const now = new Date().toISOString();
      const userLabel = await getCurrentAuditUserLabel();

      await Promise.all(uniqueIds.map(async (materialId) => {
        const material = catalog.find((item) => item.id === materialId);
        if (!material) return;

        const newRequestCount = Number(material.requestCount || 0) + 1;
        const materialUrl = await buildAuthenticatedFirebaseUrl(`${FIREBASE_DATABASE_URL}/materials/${materialId}.json`);
        const response = await fetch(materialUrl, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ requestCount: newRequestCount, lastRequestedAt: now, updatedAt: now, updatedBy: userLabel })
        });

        if (!response.ok) {
          throw new Error(`Firebase usage update failed: ${response.status}`);
        }
      }));

      const updatedCatalog = catalog.map((item) => uniqueIds.includes(item.id)
        ? { ...item, requestCount: Number(item.requestCount || 0) + 1, lastRequestedAt: now, updatedAt: now, updatedBy: userLabel }
        : item
      );
      await this.saveCatalogCache(updatedCatalog);
      return true;
    } catch (e) {
      console.error('StorageService Error (incrementMaterialRequestCount):', e);
      return false;
    }
  },

  /**
   * Saves the local Important Info cache so the screen still has data when
   * Firebase is temporarily unavailable.
   */
  async saveImportantInfoCache(items) {
    try {
      const sortedItems = sortImportantInfo((items || []).map(normalizeImportantInfoItem));
      const localCacheItems = [];
      for (const item of sortedItems) {
        localCacheItems.push(await prepareImportantInfoForLocalCache(item));
      }
      await saveImportantInfoToSQLite(localCacheItems);
      await AsyncStorage.setItem(IMPORTANT_INFO_CACHE_KEY, JSON.stringify(localCacheItems));
    } catch (e) {
      console.error('StorageService Error (saveImportantInfoCache SQLite):', e);
      try {
        await AsyncStorage.setItem(IMPORTANT_INFO_CACHE_KEY, JSON.stringify(items || []));
      } catch (storageError) {
        console.error('StorageService Error (saveImportantInfoCache AsyncStorage fallback):', storageError);
      }
    }
  },

  /**
   * Loads the local Important Info cache.
   */
  async loadImportantInfoCache() {
    try {
      const sqliteItems = await loadImportantInfoFromSQLite();
      if (sqliteItems.length > 0) return sqliteItems;
    } catch (sqliteError) {
      console.error('StorageService Error (loadImportantInfoCache SQLite):', sqliteError);
    }

    try {
      const jsonValue = await AsyncStorage.getItem(IMPORTANT_INFO_CACHE_KEY);
      if (!jsonValue) return [];
      const parsed = JSON.parse(jsonValue);
      return Array.isArray(parsed) ? sortImportantInfo(parsed.map(normalizeImportantInfoItem)) : [];
    } catch (e) {
      console.error('StorageService Error (loadImportantInfoCache AsyncStorage fallback):', e);
      return [];
    }
  },

  /**
   * Pulls the newest Important Info cards from Firebase and updates SQLite.
   */
  async syncImportantInfoFromFirebase() {
    const response = await fetch(IMPORTANT_INFO_ENDPOINT);
    if (!response.ok) throw new Error(`Firebase info load failed: ${response.status}`);
    const firebaseData = await response.json();
    const items = sortImportantInfo(convertFirebaseObjectToArray(firebaseData).map(normalizeImportantInfoItem));
    await this.saveImportantInfoCache(items);
    return items;
  },

  /**
   * Loads shared reference cards such as ground cable tables or conduit fill notes.
   * Local SQLite is read first for speed. Firebase refreshes in the background
   * when local data already exists.
   */
  async loadImportantInfo() {
    const cachedItems = await this.loadImportantInfoCache();

    if (cachedItems.length > 0) {
      this.syncImportantInfoFromFirebase().catch((error) => {
        console.error('StorageService Background Important Info Sync Error:', error);
      });
      return cachedItems;
    }

    try {
      return await this.syncImportantInfoFromFirebase();
    } catch (e) {
      console.error('StorageService Error (loadImportantInfo):', e);
      return [];
    }
  },

  /**
   * Creates or updates one Important Info card. Images are saved the same way
   * catalog images are saved: Firebase can keep a compressed data URI for syncing,
   * but the local SQLite cache only stores a lightweight file path reference.
   */
  async saveImportantInfoItem(item) {
    try {
      await ensureSharedDataEditor();
      const now = new Date().toISOString();
      const userLabel = await getCurrentAuditUserLabel();
      const existingItems = await this.loadImportantInfo();
      const existingItem = existingItems.find((currentItem) => currentItem.id === item.id) || {};
      let normalized = normalizeImportantInfoItem({
        ...item,
        id: item.id || `info-${Date.now()}`,
        createdAt: item.createdAt || now,
        updatedAt: now,
        createdBy: item.createdBy || userLabel,
        updatedBy: userLabel
      });

      normalized = await saveImportantInfoImageToFirebaseStorage(normalized);

      const oldImportantInfoImagePath = resolveStoragePath(existingItem.imageStoragePath, existingItem.imageUri);
      if (oldImportantInfoImagePath && oldImportantInfoImagePath !== normalized.imageStoragePath) {
        await deleteFirebaseStorageFileIfPossible(oldImportantInfoImagePath);
      }

      const infoUrl = await buildAuthenticatedFirebaseUrl(`${FIREBASE_DATABASE_URL}/importantInfo/${normalized.id}.json`);
      const response = await fetch(infoUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(normalized)
      });
      if (!response.ok) throw new Error(`Firebase info save failed: ${response.status}`);

      const withoutOldItem = existingItems.filter((currentItem) => currentItem.id !== normalized.id);
      const updatedItems = sortImportantInfo([...withoutOldItem, normalized]);
      await this.saveImportantInfoCache(updatedItems);
      return normalized;
    } catch (e) {
      console.error('StorageService Error (saveImportantInfoItem):', e);
      throw e;
    }
  },

  /**
   * Permanently deletes one Important Info card from Firebase and removes it from the local cache.
   */
  async deleteImportantInfoItem(itemId) {
    try {
      const user = await AuthService.getCurrentUser();
      if (user?.role !== 'owner') throw new Error('ONLY_OWNER_CAN_PERMANENTLY_DELETE');

      if (!itemId) return false;
      const existingItems = await this.loadImportantInfoCache();
      const itemToDelete = existingItems.find((item) => item.id === itemId);
      await deleteFirebaseStorageFileIfPossible(itemToDelete?.imageStoragePath);

      const infoUrl = await buildAuthenticatedFirebaseUrl(`${FIREBASE_DATABASE_URL}/importantInfo/${itemId}.json`);
      const response = await fetch(infoUrl, {
        method: 'DELETE'
      });
      if (!response.ok) throw new Error(`Firebase info delete failed: ${response.status}`);
      await this.saveImportantInfoCache(existingItems.filter((item) => item.id !== itemId));
      await removeImportantInfoRowFromSQLite(itemId);
      return true;
    } catch (e) {
      console.error('StorageService Error (deleteImportantInfoItem):', e);
      throw e;
    }
  },

  /**
   * Seeds default categories and unit measures in Firebase when the current
   * user is an owner. This keeps global configuration centralized without
   * preventing the app from working offline or under viewer/guest accounts.
   */
  async ensureDefaultCatalogSettingsInFirebase() {
    try {
      const user = await AuthService.getCurrentUser();
      if (user?.role !== 'owner') return false;

      const now = new Date().toISOString();
      await Promise.all(DEFAULT_CATEGORIES.map(async (category) => {
        const categoryKey = createCategoryKey(category);
        const url = await buildAuthenticatedFirebaseUrl(`${FIREBASE_DATABASE_URL}/categories/${categoryKey}.json`);
        await fetch(url, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: category, isCustom: false, protected: true, updatedAt: now, deletedAt: '', version: 1 })
        });
      }));

      await Promise.all(DEFAULT_UNIT_MEASURES.map(async (unit) => {
        const unitKey = createUnitMeasureKey(unit);
        const url = await buildAuthenticatedFirebaseUrl(`${FIREBASE_DATABASE_URL}/unitMeasures/${unitKey}.json`);
        await fetch(url, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: unit, isCustom: false, protected: true, updatedAt: now, deletedAt: '', version: 1 })
        });
      }));

      await setRemoteSettingsUpdatedAt();
      return true;
    } catch (error) {
      console.warn('StorageService Warning (ensureDefaultCatalogSettingsInFirebase):', error);
      return false;
    }
  },

  /**
   * Loads categories from local cache first, then syncs from Firebase.
   */
  async loadCategories() {
    try {
      StorageService.ensureDefaultCatalogSettingsInFirebase().catch(() => {});
      const cached = await AsyncStorage.getItem(CATEGORIES_CACHE_KEY);
      if (cached) {
        // Background sync
        StorageService.syncCategoriesFromFirebase().catch(console.error);
        return JSON.parse(cached);
      }
      return await StorageService.syncCategoriesFromFirebase();
    } catch (e) {
      console.error('StorageService Error (loadCategories):', e);
      return DEFAULT_CATEGORIES;
    }
  },

  async syncCategoriesFromFirebase() {
    try {
      const idToken = await AuthService.getCurrentIdToken();
      const authQuery = idToken ? `?auth=${idToken}` : '';
      const response = await fetch(`${CATEGORIES_ENDPOINT}${authQuery}`);

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          // Some accounts may not have permission to read custom categories yet.
          // Fall back quietly to local/default categories so the app keeps working offline.
          return DEFAULT_CATEGORIES;
        }
        throw new Error(`Firebase categories load failed: ${response.status}`);
      }

      const data = await response.json();

      let categories = DEFAULT_CATEGORIES;
      if (data) {
        // Firebase may store categories either as strings from older app builds
        // or as objects like { name, isCustom, createdBy }. Support both so
        // existing databases keep working after this update.
        const remoteCategories = Object.values(data)
          .filter((categoryRecord) => typeof categoryRecord === 'string' || !categoryRecord?.deletedAt)
          .map((categoryRecord) => (
            typeof categoryRecord === 'string'
              ? normalizeCategoryName(categoryRecord)
              : normalizeCategoryName(categoryRecord?.name)
          ))
          .filter(Boolean);
        categories = [...new Set([...DEFAULT_CATEGORIES, ...remoteCategories])].sort();
      }

      await AsyncStorage.setItem(CATEGORIES_CACHE_KEY, JSON.stringify(categories));
      return categories;
    } catch (e) {
      console.error('StorageService Error (syncCategoriesFromFirebase):', e);
      return DEFAULT_CATEGORIES;
    }
  },

  async addCategory(newCategory) {
    try {
      await ensureSharedDataEditor();
      const user = await AuthService.getCurrentUser();

      const cleanCategory = normalizeCategoryName(newCategory);
      if (!cleanCategory) throw new Error('EMPTY_CATEGORY');

      const existing = await StorageService.loadCategories();
      if (existing.map((category) => category.toLowerCase()).includes(cleanCategory.toLowerCase())) {
        return existing;
      }

      const categoryKey = createCategoryKey(cleanCategory);
      if (!categoryKey) throw new Error('INVALID_CATEGORY');

      const now = new Date().toISOString();
      const categoryUrl = await buildAuthenticatedFirebaseUrl(`${FIREBASE_DATABASE_URL}/categories/${categoryKey}.json`);
      const response = await fetch(categoryUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: cleanCategory,
          isCustom: true,
          createdAt: now,
          updatedAt: now,
          deletedAt: '',
          version: 1,
          createdBy: user?.uid || user?.email || 'editor',
          updatedBy: user?.uid || user?.email || 'editor'
        })
      });

      const updatedCategories = [...new Set([...existing, cleanCategory])].sort();
      await AsyncStorage.setItem(CATEGORIES_CACHE_KEY, JSON.stringify(updatedCategories));

      if (!response.ok) {
        const message = response.status === 401 || response.status === 403
          ? 'FIREBASE_CATEGORY_RULES_REQUIRED'
          : `Firebase add category failed: ${response.status}`;
        const error = new Error(message);
        error.localCategories = updatedCategories;
        throw error;
      }

      await setRemoteSettingsUpdatedAt();
      return await StorageService.syncCategoriesFromFirebase();
    } catch (e) {
      console.error('StorageService Error (addCategory):', e);
      throw e;
    }
  },

  /**
   * Loads unit measures from local cache first, then refreshes them from Firebase.
   * Catalog selection screens use only the units saved on each material, while
   * Add Material uses this master list to let owner/editor users select or add
   * units for new catalog records.
   */
  async loadUnitMeasures() {
    try {
      StorageService.ensureDefaultCatalogSettingsInFirebase().catch(() => {});
      const cached = await AsyncStorage.getItem(UNIT_MEASURES_CACHE_KEY);
      if (cached) {
        StorageService.syncUnitMeasuresFromFirebase().catch(console.error);
        return JSON.parse(cached);
      }
      return await StorageService.syncUnitMeasuresFromFirebase();
    } catch (e) {
      console.error('StorageService Error (loadUnitMeasures):', e);
      return DEFAULT_UNIT_MEASURES;
    }
  },

  async syncUnitMeasuresFromFirebase() {
    try {
      const idToken = await AuthService.getCurrentIdToken();
      const authQuery = idToken ? `?auth=${idToken}` : '';
      const response = await fetch(`${UNIT_MEASURES_ENDPOINT}${authQuery}`);

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) return DEFAULT_UNIT_MEASURES;
        throw new Error(`Firebase unit measures load failed: ${response.status}`);
      }

      const data = await response.json();
      let unitMeasures = DEFAULT_UNIT_MEASURES;
      if (data) {
        const remoteUnits = Object.values(data)
          .filter((unitRecord) => typeof unitRecord === 'string' || !unitRecord?.deletedAt)
          .map((unitRecord) => (typeof unitRecord === 'string' ? String(unitRecord).trim() : String(unitRecord?.name || '').trim()))
          .filter(Boolean);
        unitMeasures = [...new Set([...DEFAULT_UNIT_MEASURES, ...remoteUnits])].sort();
      }

      await AsyncStorage.setItem(UNIT_MEASURES_CACHE_KEY, JSON.stringify(unitMeasures));
      return unitMeasures;
    } catch (e) {
      console.error('StorageService Error (syncUnitMeasuresFromFirebase):', e);
      return DEFAULT_UNIT_MEASURES;
    }
  },

  async addUnitMeasure(newUnitMeasure) {
    try {
      await ensureSharedDataEditor();
      const user = await AuthService.getCurrentUser();
      const cleanUnit = String(newUnitMeasure || '').trim();
      if (!cleanUnit) throw new Error('EMPTY_UNIT_MEASURE');

      const existing = await StorageService.loadUnitMeasures();
      if (existing.map((unit) => unit.toLowerCase()).includes(cleanUnit.toLowerCase())) {
        return existing;
      }

      const unitKey = createUnitMeasureKey(cleanUnit);
      if (!unitKey) throw new Error('INVALID_UNIT_MEASURE');

      const now = new Date().toISOString();
      const unitUrl = await buildAuthenticatedFirebaseUrl(`${FIREBASE_DATABASE_URL}/unitMeasures/${unitKey}.json`);
      const response = await fetch(unitUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: cleanUnit,
          isCustom: true,
          createdAt: now,
          updatedAt: now,
          deletedAt: '',
          version: 1,
          createdBy: user?.uid || user?.email || 'editor',
          updatedBy: user?.uid || user?.email || 'editor'
        })
      });

      const updatedUnits = [...new Set([...existing, cleanUnit])].sort();
      await AsyncStorage.setItem(UNIT_MEASURES_CACHE_KEY, JSON.stringify(updatedUnits));

      if (!response.ok) {
        const error = new Error(response.status === 401 || response.status === 403 ? 'FIREBASE_UNIT_RULES_REQUIRED' : `Firebase add unit failed: ${response.status}`);
        error.localUnitMeasures = updatedUnits;
        throw error;
      }

      return await StorageService.syncUnitMeasuresFromFirebase();
    } catch (e) {
      console.error('StorageService Error (addUnitMeasure):', e);
      throw e;
    }
  },

  async deleteCategory(categoryName) {
    try {
      const user = await AuthService.getCurrentUser();
      const isOwner = user?.role === 'owner';

      if (!isOwner) throw new Error('ONLY_OWNER_CAN_DELETE_CATEGORIES');

      const cleanCategory = normalizeCategoryName(categoryName);
      if (!cleanCategory) throw new Error('EMPTY_CATEGORY');

      if (DEFAULT_CATEGORY_KEYS.includes(cleanCategory.toLowerCase())) {
        throw new Error('DEFAULT_CATEGORY_CANNOT_BE_DELETED');
      }

      const categoryKey = createCategoryKey(cleanCategory);
      if (!categoryKey) throw new Error('INVALID_CATEGORY');

      const now = new Date().toISOString();
      const categoryUrl = await buildAuthenticatedFirebaseUrl(`${FIREBASE_DATABASE_URL}/categories/${categoryKey}.json`);
      const response = await fetch(categoryUrl, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deletedAt: now, updatedAt: now, updatedBy: user?.uid || user?.email || 'owner' })
      });

      const existing = await StorageService.loadCategories();
      const updatedCategories = existing.filter((category) => category.toLowerCase() !== cleanCategory.toLowerCase());
      await AsyncStorage.setItem(CATEGORIES_CACHE_KEY, JSON.stringify(updatedCategories));

      if (!response.ok) {
        const message = response.status === 401 || response.status === 403
          ? 'FIREBASE_CATEGORY_RULES_REQUIRED'
          : `Firebase delete category failed: ${response.status}`;
        const error = new Error(message);
        error.localCategories = updatedCategories;
        throw error;
      }

      await setRemoteSettingsUpdatedAt();
      return await StorageService.syncCategoriesFromFirebase();
    } catch (e) {
      console.error('StorageService Error (deleteCategory):', e);
      throw e;
    }
  },

  /**
   * Permanently deletes a material from Firebase.
   * This should only be called by an Owner/Admin after reviewing soft-deleted items.
   */
  async permanentDeleteMaterial(materialId) {
    try {
      const user = await AuthService.getCurrentUser();
      const isOwner = user?.role === 'owner';

      if (!isOwner) {
        throw new Error('ONLY_OWNER_CAN_PERMANENTLY_DELETE');
      }

      if (!materialId) return false;
      const existingCatalog = await this.loadCatalogCache();
      const materialToDelete = existingCatalog.find((item) => item.id === materialId);
      await deleteFirebaseStorageFileIfPossible(materialToDelete?.imageStoragePath);
      await deleteFirebaseStorageFileIfPossible(materialToDelete?.groupCoverStoragePath);

      const now = new Date().toISOString();
      const deletedBy = user?.uid || user?.email || 'owner';
      const deleteLogUrl = await buildAuthenticatedFirebaseUrl(`${FIREBASE_DATABASE_URL}/catalogDeleted/${materialId}.json`);
      await fetch(deleteLogUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: materialId, deletedAt: now, deletedBy })
      });

      const materialUrl = await buildAuthenticatedFirebaseUrl(`${FIREBASE_DATABASE_URL}/materials/${materialId}.json`);
      const response = await fetch(materialUrl, {
        method: 'DELETE'
      });
      if (!response.ok) throw new Error(`Firebase material permanent delete failed: ${response.status}`);

      await setRemoteCatalogUpdatedAt();
      await this.saveCatalogCache(existingCatalog.filter((item) => item.id !== materialId));
      await removeCatalogRowFromSQLite(materialId);
      return true;
    } catch (e) {
      console.error('StorageService Error (permanentDeleteMaterial):', e);
      throw e;
    }
  },

  async compactLocalCatalogCache() {
    try {
      const database = await getSQLiteDatabase();
      await database.runAsync(`DELETE FROM ${CATALOG_TABLE_NAME} WHERE deleted = 1;`);
      await database.runAsync(`VACUUM;`);
      return true;
    } catch (error) {
      console.warn('StorageService Warning (compactLocalCatalogCache):', error);
      return false;
    }
  },

  async resetIncrementalSyncState() {
    await AsyncStorage.multiRemove([CATALOG_LAST_INCREMENTAL_SYNC_AT_KEY, CATALOG_CLOUD_UPDATED_AT_KEY, SETTINGS_CLOUD_UPDATED_AT_KEY]);
    return true;
  },

  /**
   * Wipes only local data. It does not delete the Firebase catalog.
   */
  async clearLocalCatalogCache() {
    await resetCatalogSQLiteCache();
    await AsyncStorage.multiRemove([CATALOG_CACHE_KEY, CATALOG_CACHE_SCHEMA_KEY, CATALOG_LAST_INCREMENTAL_SYNC_AT_KEY, CATALOG_CLOUD_UPDATED_AT_KEY]);
  },

  async clearAllData() {
    try {
      await AsyncStorage.multiRemove([DRAFT_KEY, CATALOG_CACHE_KEY, IMPORTANT_INFO_CACHE_KEY]);
      try {
        await runSQLiteWriteSafely(async () => {
          const database = await getSQLiteDatabase();
          await database.execAsync(`DELETE FROM ${CATALOG_TABLE_NAME}; DELETE FROM ${IMPORTANT_INFO_TABLE_NAME}; VACUUM;`);
        });
      } catch (sqliteError) {
        console.error('Error clearing SQLite cache:', sqliteError);
      }
      console.log('Local app data cleared. Firebase catalog was not deleted.');
    } catch (e) {
      console.error('Error clearing data:', e);
    }
  },

  /**
   * Manually reclaims disk space by running SQLite VACUUM.
   * Call this when large amounts of data (like photos) are removed.
   */
  async reclaimDiskSpace() {
    try {
      await runSQLiteWriteSafely(async () => {
        const database = await getSQLiteDatabase();
        await database.runAsync('VACUUM;');
      });
      return true;
    } catch (error) {
      console.error('StorageService Error (reclaimDiskSpace):', error);
      return false;
    }
  },

  /**
   * Loads the current user's cable/wire requirement draft. The local copy opens
   * instantly; Firebase is used as a lightweight backup/shared source.
   */
  async loadCableRequirementDraft() {
    const user = await AuthService.getCurrentUser();
    const userKey = String(user?.uid || user?.email || 'guest').replace(/[^a-zA-Z0-9_-]/g, '_');
    const localKey = `${CABLE_REQUIREMENT_DRAFT_KEY}_${userKey}`;
    try {
      const localText = await AsyncStorage.getItem(localKey);
      if (localText) return JSON.parse(localText);

      const database = await getSQLiteDatabase();
      const row = await database.getFirstAsync(
        `SELECT data FROM ${CABLE_REQUIREMENT_TABLE_NAME} WHERE id = ? LIMIT 1;`,
        [userKey]
      );
      return row?.data ? JSON.parse(row.data) : null;
    } catch (error) {
      console.warn('Cable requirement local draft warning:', error);
      return null;
    }
  },

  /**
   * Cable/Wire requirement sheets are working drafts, so they stay local.
   * Typing, changing a length, deleting a row, or generating a report must not
   * create Firebase traffic. Firebase is contacted only when the reusable
   * cable catalog itself changes or during the lightweight catalog version check.
   */
  async saveCableRequirementDraft(draft) {
    const user = await AuthService.getCurrentUser();
    const userKey = String(user?.uid || user?.email || 'guest').replace(/[^a-zA-Z0-9_-]/g, '_');
    const localKey = `${CABLE_REQUIREMENT_DRAFT_KEY}_${userKey}`;
    const normalized = {
      projectName: String(draft?.projectName || ''),
      requestedBy: String(draft?.requestedBy || ''),
      items: Array.isArray(draft?.items) ? draft.items : [],
      updatedAt: draft?.updatedAt || new Date().toISOString(),
      version: Number(draft?.version || 1),
    };
    await AsyncStorage.setItem(localKey, JSON.stringify(normalized));
    const database = await getSQLiteDatabase();
    await database.runAsync(
      `INSERT OR REPLACE INTO ${CABLE_REQUIREMENT_TABLE_NAME} (id, data, updatedAt) VALUES (?, ?, ?);`,
      [userKey, JSON.stringify(normalized), normalized.updatedAt]
    );
    return normalized;
  },

  async loadCableCatalogCache() {
    try {
      const database = await getSQLiteDatabase();
      const rows = await database.getAllAsync(`SELECT data FROM ${CABLE_CATALOG_TABLE_NAME} WHERE deleted = 0 ORDER BY updatedAt DESC;`);
      if (rows?.length) return rows.map((row) => JSON.parse(row.data));
      const text = await AsyncStorage.getItem(CABLE_CATALOG_CACHE_KEY);
      return text ? JSON.parse(text) : [];
    } catch (error) {
      console.warn('Cable catalog cache warning:', error);
      return [];
    }
  },

  async syncCableCatalog({ force = false } = {}) {
    const localCatalog = await this.loadCableCatalogCache();
    try {
      // Only download a tiny metadata record first. If its version/timestamp is
      // unchanged, the complete cable catalog never leaves Firebase.
      const localMetaText = await AsyncStorage.getItem(CABLE_CATALOG_META_KEY);
      const localMeta = localMetaText ? JSON.parse(localMetaText) : null;
      const metaUrl = await buildOptionalAuthenticatedFirebaseUrl(CABLE_CATALOG_META_ENDPOINT);
      const metaResponse = await fetch(metaUrl);
      const remoteMeta = metaResponse.ok ? await metaResponse.json() : null;

      const unchanged = !force && localCatalog.length > 0 && remoteMeta && localMeta
        && String(remoteMeta.version || '') === String(localMeta.version || '')
        && String(remoteMeta.latestUpdatedAt || '') === String(localMeta.latestUpdatedAt || '');

      if (unchanged) {
        return localCatalog.sort((a, b) => String(a.name).localeCompare(String(b.name)));
      }

      const url = await buildOptionalAuthenticatedFirebaseUrl(CABLE_CATALOG_ENDPOINT);
      const response = await fetch(url);
      if (!response.ok) return localCatalog;
      const payload = await response.json();
      const remoteCatalog = Object.entries(payload || {})
        .map(([id, value]) => ({ id, ...value }))
        .filter((item) => !item.deletedAt);

      await AsyncStorage.setItem(CABLE_CATALOG_CACHE_KEY, JSON.stringify(remoteCatalog));
      await AsyncStorage.setItem(CABLE_CATALOG_META_KEY, JSON.stringify(remoteMeta || {
        version: remoteCatalog.length,
        latestUpdatedAt: remoteCatalog.reduce((latest, item) => String(item.updatedAt || '') > latest ? String(item.updatedAt || '') : latest, ''),
      }));
      const database = await getSQLiteDatabase();
      await database.runAsync(`DELETE FROM ${CABLE_CATALOG_TABLE_NAME};`);
      for (const entry of remoteCatalog) {
        await database.runAsync(
          `INSERT OR REPLACE INTO ${CABLE_CATALOG_TABLE_NAME} (id, data, updatedAt, deleted) VALUES (?, ?, ?, 0);`,
          [entry.id, JSON.stringify(entry), entry.updatedAt || '']
        );
      }
      return remoteCatalog.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    } catch (error) {
      console.warn('Cable catalog sync warning:', error);
      return localCatalog;
    }
  },

  async saveCableCatalogEntry(entry) {
    await ensureSharedDataEditor();

    const normalizeCableWireCatalogName = (value) => String(value || '')
      .trim()
      .toUpperCase()
      .replace(/[“”]/g, '"')
      .replace(/\s+/g, ' ')
      .replace(/(\d+)\s*C(?=\s|#|-|\d|$)/g, '$1 C')
      .replace(/\s*#\s*/g, ' # ')
      .replace(/\s*-\s*/g, ' - ')
      .replace(/\s+/g, ' ')
      .replace(/^#\s*/, '# ')
      .trim();

    const cleanName = normalizeCableWireCatalogName(entry?.name);
    const type = entry?.type === 'wire' ? 'wire' : 'cable';
    if (!cleanName) throw new Error('CABLE_NAME_REQUIRED');

    const currentCatalog = await this.loadCableCatalogCache();
    const requestedId = String(entry?.id || '').trim();
    const generatedId = `${type}-${cleanName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`;
    const id = requestedId || generatedId;

    const duplicate = currentCatalog.find((item) =>
      item.id !== id
      && item.type === type
      && normalizeCableWireCatalogName(item.name).replace(/\s+/g, '') === cleanName.replace(/\s+/g, '')
    );
    if (duplicate) throw new Error('CABLE_CATALOG_NAME_ALREADY_EXISTS');

    const existingRecord = currentCatalog.find((item) => item.id === id);
    const userLabel = await getCurrentAuditUserLabel();
    const now = new Date().toISOString();
    const record = {
      ...(existingRecord || {}),
      id,
      type,
      name: cleanName,
      updatedAt: now,
      updatedBy: userLabel,
      version: Number(existingRecord?.version || 0) + 1,
      deletedAt: null,
    };

    const url = await buildAuthenticatedFirebaseUrl(`${FIREBASE_DATABASE_URL}/cableCatalog/${id}.json`);
    const response = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(record),
    });
    if (!response.ok) throw new Error(`Firebase cable catalog save failed: ${response.status}`);

    const nextCatalog = [...currentCatalog.filter((item) => item.id !== id), record]
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
    await AsyncStorage.setItem(CABLE_CATALOG_CACHE_KEY, JSON.stringify(nextCatalog));

    const database = await getSQLiteDatabase();
    await database.runAsync(
      `INSERT OR REPLACE INTO ${CABLE_CATALOG_TABLE_NAME} (id, data, updatedAt, deleted) VALUES (?, ?, ?, 0);`,
      [record.id, JSON.stringify(record), record.updatedAt]
    );

    const oldMetaText = await AsyncStorage.getItem(CABLE_CATALOG_META_KEY);
    const oldMeta = oldMetaText ? JSON.parse(oldMetaText) : {};
    const nextVersion = Number(oldMeta.version || oldMeta.latestVersion || 0) + 1;
    const nextMeta = {
      version: nextVersion,
      latestVersion: nextVersion,
      latestUpdatedAt: now,
    };
    const metaUrl = await buildAuthenticatedFirebaseUrl(CABLE_CATALOG_META_ENDPOINT);
    const metaResponse = await fetch(metaUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(nextMeta),
    });
    if (!metaResponse.ok) {
      console.warn(`Cable catalog metadata update warning: ${metaResponse.status}`);
    }
    await AsyncStorage.setItem(CABLE_CATALOG_META_KEY, JSON.stringify(nextMeta));
    return nextCatalog;
  },

  async deleteCableCatalogEntry(entryId) {
    await ensureSharedDataEditor();
    const currentCatalog = await this.loadCableCatalogCache();
    if (!entryId) return currentCatalog;
    const userLabel = await getCurrentAuditUserLabel();
    const now = new Date().toISOString();
    const url = await buildAuthenticatedFirebaseUrl(`${FIREBASE_DATABASE_URL}/cableCatalog/${entryId}.json`);
    const response = await fetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deletedAt: now, deletedBy: userLabel, updatedAt: now }),
    });
    if (!response.ok) throw new Error(`Firebase cable catalog delete failed: ${response.status}`);

    const nextCatalog = currentCatalog.filter((item) => item.id !== entryId);
    await AsyncStorage.setItem(CABLE_CATALOG_CACHE_KEY, JSON.stringify(nextCatalog));
    const database = await getSQLiteDatabase();
    await database.runAsync(`DELETE FROM ${CABLE_CATALOG_TABLE_NAME} WHERE id = ?;`, [entryId]);

    const oldMetaText = await AsyncStorage.getItem(CABLE_CATALOG_META_KEY);
    const oldMeta = oldMetaText ? JSON.parse(oldMetaText) : {};
    const nextVersion = Number(oldMeta.version || oldMeta.latestVersion || 0) + 1;
    const nextMeta = { version: nextVersion, latestVersion: nextVersion, latestUpdatedAt: now };
    const metaUrl = await buildAuthenticatedFirebaseUrl(CABLE_CATALOG_META_ENDPOINT);
    await fetch(metaUrl, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(nextMeta) });
    await AsyncStorage.setItem(CABLE_CATALOG_META_KEY, JSON.stringify(nextMeta));
    return nextCatalog;
  },

};

/**
 * AddMaterialScreen
 * -----------------
 * Form used to create a new catalog material. The form now starts with the
 * material family/group decision because family organization controls how the
 * catalog groups repeated items such as drill bits, EMT pipe, THHN colors, or
 * fittings with different sizes.
 *
 * Main behavior:
 * - If an existing family is selected, the material can be added by entering
 *   only the new size/variant and description.
 * - If a new family is needed, the user can create it with the material name or
 *   a custom family name.
 * - The material name, size, and description stay separate so a family name does
 *   not overwrite the actual material variant information.
 */
import React, { useEffect, useMemo, useState } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TextInput,
  TouchableOpacity,
  Alert,
  ScrollView,
  Image,
  ActivityIndicator,
  BackHandler,
  KeyboardAvoidingView,
  Platform
} from 'react-native';
import { StorageService } from '../database/storage';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';

const DEFAULT_UNIT_OPTIONS = ['Unit', 'Box', 'Bundle', 'Reel', 'Length (ft)', 'Length (in)', 'Bottle'];

const getDefaultAllowedUnitsByCategory = (category) => {
  switch ((category || '').toLowerCase()) {
    case 'conductors':
      return ['Unit', 'Reel', 'Length (ft)'];
    case 'conduits':
      return ['Unit', 'Bundle'];
    case 'devices':
      return ['Unit', 'Box'];
    case 'tools':
      return ['Unit', 'Box'];
    case 'boxes':
    case 'connectors':
    case 'fittings':
    case 'others':
    default:
      return ['Unit', 'Box', 'Bundle'];
  }
};

const normalizeFamilyKeyText = (value) => String(value || '')
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9#]+/g, '-');

const buildFamilyOptions = (catalog) => {
  const map = new Map();
  (catalog || []).forEach((material) => {
    const familyName = String(material?.familyName || material?.name || '').trim();
    if (!familyName) return;
    const category = material?.category || 'Others';
    const key = `${category.toLowerCase()}::${normalizeFamilyKeyText(familyName)}`;
    const existing = map.get(key) || {
      key,
      name: familyName,
      category,
      description: material.description || '',
      allowedUnits: Array.isArray(material.allowedUnits) ? material.allowedUnits : getDefaultAllowedUnitsByCategory(category),
      count: 0
    };
    existing.count += 1;
    if (!existing.description && material.description) existing.description = material.description;
    map.set(key, existing);
  });
  return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
};

const scoreFamilySuggestion = (family, searchText) => {
  const search = String(searchText || '').trim().toLowerCase();
  if (!search) return 0;
  const familyName = String(family?.name || '').toLowerCase();
  if (familyName === search) return 100;
  if (familyName.includes(search) || search.includes(familyName)) return 80;
  const searchWords = search.split(/\s+/).filter(Boolean);
  const familyWords = familyName.split(/\s+/).filter(Boolean);
  return searchWords.filter((word) => familyWords.includes(word)).length * 20;
};

export default function AddMaterialScreen({ navigation, currentUser }) {
  const [categories, setCategories] = useState([]);
  const [showAddCategory, setShowAddCategory] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState('');
  const [addingCategory, setAddingCategory] = useState(false);
  const [deletingCategory, setDeletingCategory] = useState(false);
  const [unitOptions, setUnitOptions] = useState(DEFAULT_UNIT_OPTIONS);
  const [showCustomUnitCreator, setShowCustomUnitCreator] = useState(false);

  const [familyOptions, setFamilyOptions] = useState([]);
  const [familySearchText, setFamilySearchText] = useState('');
  const [selectedFamilyKey, setSelectedFamilyKey] = useState('new-family');
  const [createNewFamily, setCreateNewFamily] = useState(true);
  const [useMaterialNameForFamily, setUseMaterialNameForFamily] = useState(true);
  const [customFamilyName, setCustomFamilyName] = useState('');

  const [materialName, setMaterialName] = useState('');
  const [size, setSize] = useState('');
  const [skipVariantSelection, setSkipVariantSelection] = useState(false);
  const [description, setDescription] = useState('');
  const [forceShowDescription, setForceShowDescription] = useState(false);
  const [category, setCategory] = useState('Conduits');
  const [allowedUnits, setAllowedUnits] = useState(getDefaultAllowedUnitsByCategory('Conduits'));
  const [customUnitName, setCustomUnitName] = useState('');
  const [imageUri, setImageUri] = useState('');
  const [groupCoverUri, setGroupCoverUri] = useState('');
  const [showGroupCoverPicker, setShowGroupCoverPicker] = useState(false);
  const [showIndividualImagePicker, setShowIndividualImagePicker] = useState(false);
  const [saving, setSaving] = useState(false);

  const canEditSharedData = currentUser?.role === 'owner' || currentUser?.role === 'editor';

  useEffect(() => {
    let isMounted = true;
    const loadData = async () => {
      try {
        const [catalog, fetchedCategories, fetchedUnitMeasures] = await Promise.all([
          StorageService.loadCatalogCache(),
          StorageService.loadCategories(),
          StorageService.loadUnitMeasures()
        ]);
        if (isMounted) {
          setFamilyOptions(buildFamilyOptions(catalog));
          setCategories(fetchedCategories);
          setUnitOptions(Array.isArray(fetchedUnitMeasures) && fetchedUnitMeasures.length > 0 ? fetchedUnitMeasures : DEFAULT_UNIT_OPTIONS);
        }
      } catch (error) {
        console.warn('Could not load data for AddMaterialScreen.', error);
      }
    };
    loadData();
    return () => { isMounted = false; };
  }, []);

  useEffect(() => {
    if (!canEditSharedData) {
      Alert.alert('Viewer Access Only', 'Guest and viewer accounts cannot add catalog materials.', [
        { text: 'OK', onPress: () => navigation.goBack() }
      ]);
    }
  }, [canEditSharedData, navigation]);

  const selectedFamily = familyOptions.find((family) => family.key === selectedFamilyKey);

  const filteredFamilyOptions = useMemo(() => {
    const text = familySearchText.trim().toLowerCase();
    const materialText = materialName.trim();
    const baseList = text
      ? familyOptions.filter((family) => String(family.name).toLowerCase().includes(text) || String(family.category).toLowerCase().includes(text))
      : familyOptions;

    return [...baseList]
      .sort((a, b) => scoreFamilySuggestion(b, materialText) - scoreFamilySuggestion(a, materialText) || a.name.localeCompare(b.name));
  }, [familyOptions, familySearchText, materialName]);

  const resolvedMaterialName = () => {
    const cleanMaterialName = materialName.trim();
    if (cleanMaterialName) return cleanMaterialName;
    // If the material is being added to a family that uses list-style variants
    // (for example 4x4 Electrical Box or 4x4 Cover Blind Plate), the material
    // name must be explicitly typed. Do not silently replace it with the family
    // name because the variant itself is the selectable label.
    if (skipVariantSelection) return '';
    if (!createNewFamily && selectedFamily?.name) return selectedFamily.name;
    return '';
  };

  const resolvedFamilyName = () => {
    if (!createNewFamily) return selectedFamily?.name || '';
    return useMaterialNameForFamily ? resolvedMaterialName() : customFamilyName.trim();
  };

  const getDisplayName = () => {
    const cleanName = resolvedMaterialName();
    const cleanSize = size.trim();
    const sizeText = (!skipVariantSelection && cleanSize) ? ` ${cleanSize}` : '';
    return cleanName ? `${cleanName}${sizeText}` : 'Material preview';
  };

  const handleCategoryChange = (selectedCategory) => {
    setCategory(selectedCategory);
    setAllowedUnits(getDefaultAllowedUnitsByCategory(selectedCategory));
    if (!createNewFamily) {
      setSelectedFamilyKey('new-family');
      setCreateNewFamily(true);
    }
  };

  const selectExistingFamily = (family) => {
    setCreateNewFamily(false);
    setSelectedFamilyKey(family.key);
    setCategory(family.category || 'Others');
    setMaterialName((current) => current.trim() ? current : family.name);
    setDescription((current) => current.trim() ? current : family.description || '');
    setAllowedUnits(Array.isArray(family.allowedUnits) && family.allowedUnits.length > 0 ? family.allowedUnits : getDefaultAllowedUnitsByCategory(family.category));
  };

  const startNewFamily = () => {
    setCreateNewFamily(true);
    setSelectedFamilyKey('new-family');
  };

  // Toggle which units this material will show later in the catalog order modal.
  // The Custom Unit button is only available here while creating/editing catalog
  // data. Once a custom unit is created, it becomes a normal saved unit and will
  // appear with the rest of the unit buttons.
  const toggleAllowedUnit = (unit) => {
    if (unit === 'Custom Unit') {
      setShowCustomUnitCreator((current) => !current);
      return;
    }
    setAllowedUnits((current) => current.includes(unit) ? current.filter((item) => item !== unit) : [...current, unit]);
  };

  const addCustomUnitToList = async () => {
    const cleanUnit = customUnitName.trim();
    if (!cleanUnit) {
      Alert.alert('Custom Unit Required', 'Please type the custom unit before adding it.');
      return;
    }
    try {
      const updatedUnits = await StorageService.addUnitMeasure(cleanUnit);
      setUnitOptions(updatedUnits);
    } catch (error) {
      // If Firebase rules are not ready, still allow this device to use the unit
      // so the user can keep working, then show a clear message about global sync.
      if (Array.isArray(error.localUnitMeasures)) {
        setUnitOptions(error.localUnitMeasures);
      }
      Alert.alert('Unit Saved Locally', 'The custom unit was added on this device. Check Firebase /unitMeasures rules if it does not sync to other users.');
    }
    setAllowedUnits((current) => current.includes(cleanUnit) ? current : [...current, cleanUnit]);
    setCustomUnitName('');
    setShowCustomUnitCreator(false);
  };

  const handleAddCategory = async () => {
    if (!newCategoryName.trim()) return;
    try {
      setAddingCategory(true);
      const updatedCategories = await StorageService.addCategory(newCategoryName);
      setCategories(updatedCategories);
      setCategory(newCategoryName.trim());
      setNewCategoryName('');
      setShowAddCategory(false);
      Alert.alert('Success', 'New category added globally.');
    } catch (error) {
      console.error('Error adding category:', error);
      if (error.message === 'FIREBASE_CATEGORY_RULES_REQUIRED' && Array.isArray(error.localCategories)) {
        setCategories(error.localCategories);
        setCategory(newCategoryName.trim());
        setNewCategoryName('');
        setShowAddCategory(false);
        Alert.alert(
          'Category Saved Locally',
          'The category was added to this device, but Firebase rejected the global update. Publish the /categories rules included with this update so all users can share custom categories.'
        );
      } else {
        Alert.alert(
          'Category Error',
          error.message === 'FIREBASE_CATEGORY_RULES_REQUIRED'
            ? 'Firebase rejected the category update. Check Realtime Database rules for /categories and confirm this account is owner.'
            : 'Could not add category. Only owners can perform this action.'
        );
      }
    } finally {
      setAddingCategory(false);
    }
  };


  const handleDeleteCategory = async () => {
    if (!canDeleteSelectedCategory) return;

    Alert.alert(
      'Delete Category',
      `Delete the category "${category}" from Firebase? Existing materials will not be deleted, but this category will no longer appear as an option.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete Category',
          style: 'destructive',
          onPress: async () => {
            try {
              setDeletingCategory(true);
              const updatedCategories = await StorageService.deleteCategory(category);
              setCategories(updatedCategories);
              setCategory(updatedCategories[0] || 'Others');
              setAllowedUnits(getDefaultAllowedUnitsByCategory(updatedCategories[0] || 'Others'));
              Alert.alert('Deleted', 'Category removed globally.');
            } catch (error) {
              console.error('Error deleting category:', error);
              Alert.alert('Error', error.message === 'DEFAULT_CATEGORY_CANNOT_BE_DELETED' ? 'Default categories cannot be deleted.' : 'Could not delete category. Owner role is required.');
            } finally {
              setDeletingCategory(false);
            }
          }
        }
      ]
    );
  };

  const isOwner = currentUser?.role === 'owner';
  const protectedCategories = ['Conduits', 'Connectors', 'Conductors', 'Devices', 'Boxes', 'Fittings', 'Tools', 'Others'];
  const canDeleteSelectedCategory = isOwner && category && !protectedCategories.map((item) => item.toLowerCase()).includes(String(category).toLowerCase());

  const resizeSelectedImage = async (uri) => {
    const resizedImage = await ImageManipulator.manipulateAsync(
      uri,
      [{ resize: { width: 700 } }],
      { compress: 0.5, format: ImageManipulator.SaveFormat.JPEG, base64: true }
    );
    return `data:image/jpeg;base64,${resizedImage.base64}`;
  };

  const pickImageFromLibrary = async (type = 'individual') => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('Permission Required', 'Please allow photo library access to select a material image.');
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      quality: 0.8
    });

    if (!result.canceled && result.assets?.length > 0) {
      const processedImage = await resizeSelectedImage(result.assets[0].uri);
      if (type === 'group') {
        setGroupCoverUri(processedImage);
      } else {
        setImageUri(processedImage);
      }
    }
  };

  const takePhotoWithCamera = async (type = 'individual') => {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('Permission Required', 'Please allow camera access to take a material photo.');
      return;
    }

    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      quality: 0.8
    });

    if (!result.canceled && result.assets?.length > 0) {
      const processedImage = await resizeSelectedImage(result.assets[0].uri);
      if (type === 'group') {
        setGroupCoverUri(processedImage);
      } else {
        setImageUri(processedImage);
      }
    }
  };

  useEffect(() => {
    const handleDeviceBack = () => {
      if (navigation.canGoBack()) {
        navigation.goBack();
        return true;
      }
      return false;
    };

    const subscription = BackHandler.addEventListener('hardwareBackPress', handleDeviceBack);
    return () => subscription.remove();
  }, [navigation]);

  const handleSaveMaterial = async () => {
    const finalMaterialName = resolvedMaterialName();
    const finalFamilyName = resolvedFamilyName();

    if (!finalFamilyName) {
      Alert.alert('Required Field', 'Please select an existing family or create a new family name.');
      return;
    }

    if (!finalMaterialName) {
      Alert.alert('Required Field', 'Please enter the material name.');
      return;
    }

    if (!skipVariantSelection && !size.trim()) {
      Alert.alert('Required Field', 'Please enter the custom size, color, or variant, or check "No separate size/color/variant needed".');
      return;
    }

    if (allowedUnits.length === 0) {
      Alert.alert('Required Field', 'Please select at least one unit of measure.');
      return;
    }

    try {
      setSaving(true);

      const newMaterial = {
        name: finalMaterialName,
        familyName: finalFamilyName,
        category,
        size: skipVariantSelection ? 'N/A' : size.trim(),
        familyDisplayMode: skipVariantSelection ? 'list' : '',
        imageUri: showIndividualImagePicker ? imageUri : '',
        groupCoverUri: showGroupCoverPicker ? groupCoverUri : '',
        description: description.trim(),
        forceShowDescription,
        allowedUnits
      };

      await StorageService.addMaterial(newMaterial);

      Alert.alert('Success!', `"${getDisplayName()}" added to Firebase catalog.`, [
        {
          text: 'OK',
          onPress: () => {
            setMaterialName('');
            setSize('');
            setSkipVariantSelection(false);
            setImageUri('');
            setDescription('');
            setAllowedUnits(getDefaultAllowedUnitsByCategory(category));
            setSkipVariantSelection(false);
            navigation.replace('CatalogManager');
          }
        }
      ]);
    } catch (error) {
      console.error('Error saving material:', error);
      if (error.message === 'DUPLICATE_MATERIAL') {
        Alert.alert('Duplicate Material', 'This material name with this size already exists.');
      } else {
        Alert.alert('Error', 'Could not save material to Firebase. Please check your internet connection and database rules.');
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={['left', 'right', 'bottom']}>
      <StatusBar style="light" />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'} keyboardVerticalOffset={90}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <Text style={styles.title}>NEW MATERIAL TO CATALOG</Text>

          <Text style={styles.label}>1. Family / Group:</Text>
          <View style={styles.familyPickerCard}>
            <TouchableOpacity
              style={[styles.checkboxRow, createNewFamily && styles.checkboxRowActive]}
              onPress={startNewFamily}
            >
              <Text style={styles.checkboxBox}>{createNewFamily ? '☑' : '☐'}</Text>
              <View style={{ flex: 1 }}>
                <Text style={[styles.familyOptionText, createNewFamily && styles.familyOptionTextActive]}>Create a new family/group</Text>
                <Text style={styles.familyOptionSubText}>Use this when no current family matches the new material.</Text>
              </View>
            </TouchableOpacity>

            {createNewFamily ? (
              <View style={styles.newFamilyPanel}>
                <TouchableOpacity style={styles.checkboxRow} onPress={() => setUseMaterialNameForFamily((value) => !value)}>
                  <Text style={styles.checkboxBox}>{useMaterialNameForFamily ? '☑' : '☐'}</Text>
                  <Text style={styles.familyOptionText}>Use material name as family name</Text>
                </TouchableOpacity>
                {!useMaterialNameForFamily ? (
                  <TextInput
                    style={styles.input}
                    value={customFamilyName}
                    onChangeText={setCustomFamilyName}
                    placeholder="Custom family name, e.g.: Drill Bits"
                    placeholderTextColor="#99a"
                  />
                ) : null}
              </View>
            ) : selectedFamily ? (
              <View style={styles.selectedFamilyPanel}>
                <Text style={styles.previewLabel}>Selected Family</Text>
                <Text style={styles.previewText}>{selectedFamily.name}</Text>
                <Text style={styles.familyOptionSubText}>{selectedFamily.category} • {selectedFamily.count} existing item{selectedFamily.count === 1 ? '' : 's'}</Text>
              </View>
            ) : null}

            <TextInput
              style={styles.input}
              value={familySearchText}
              onChangeText={setFamilySearchText}
              placeholder="Search existing family, e.g.: Drill Bits, EMT Pipe, THHN #12"
              placeholderTextColor="#99a"
            />
            <Text style={styles.helperText}>Select an existing family when the new entry is only another size, color, or variant.</Text>

            <ScrollView style={{ maxHeight: 210 }} nestedScrollEnabled keyboardShouldPersistTaps="handled">
              {filteredFamilyOptions.map((family) => {
                const suggested = scoreFamilySuggestion(family, materialName) > 0;
                return (
                  <TouchableOpacity
                    key={family.key}
                    style={[styles.familyOption, !createNewFamily && selectedFamilyKey === family.key && styles.familyOptionActive, suggested && styles.suggestedFamilyOption]}
                    onPress={() => selectExistingFamily(family)}
                  >
                    <Text style={[styles.familyOptionText, !createNewFamily && selectedFamilyKey === family.key && styles.familyOptionTextActive]}>
                      {suggested ? 'Suggested • ' : ''}{family.name}
                    </Text>
                    <Text style={styles.familyOptionSubText}>{family.category} • {family.count} existing item{family.count === 1 ? '' : 's'}</Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          </View>

          <Text style={styles.label}>2. Material Name:</Text>
          <TextInput
            style={styles.input}
            value={materialName}
            onChangeText={setMaterialName}
            placeholder={createNewFamily ? 'e.g.: Drill Bit, EMT Pipe, Plastic LB' : 'Auto-filled from family; edit only if needed'}
            placeholderTextColor="#99a"
          />
          <Text style={styles.helperText}>{createNewFamily ? 'Type the base name only. Do not include the size here.' : 'If left blank, the selected family name will be used automatically.'}</Text>

          <Text style={styles.label}>3. Custom Size / Color / Variant:</Text>
          <TouchableOpacity style={styles.checkboxRow} onPress={() => setSkipVariantSelection((value) => !value)}>
            <Text style={styles.checkboxBox}>{skipVariantSelection ? '☑' : '☐'}</Text>
            <View style={{ flex: 1 }}>
              <Text style={styles.familyOptionText}>No separate size/color/variant needed</Text>
              <Text style={styles.familyOptionSubText}>Use this for special groups where the full material name is enough, like 4x4 Electrical Box or 4x4 Cover Blind Plate.</Text>
            </View>
          </TouchableOpacity>
          {!skipVariantSelection ? (
            <>
              <TextInput
                style={styles.input}
                value={size}
                onChangeText={setSize}
                placeholder='e.g.: 7/32", 1/8", 3/4", Black, Red, SDS 1/4 x 6'
                placeholderTextColor="#99a"
              />
              <Text style={styles.helperText}>This is the new selectable option that will appear inside the family.</Text>
            </>
          ) : (
            <Text style={styles.helperText}>The material will appear inside its family by name instead of size or color.</Text>
          )}

          <View style={styles.previewCard}>
            <Text style={styles.previewLabel}>Catalog Display Preview</Text>
            <Text style={styles.previewText}>{getDisplayName()}</Text>
            <Text style={styles.familyOptionSubText}>Family: {resolvedFamilyName() || 'Not selected yet'}</Text>
          </View>

          <Text style={styles.label}>4. Description (Optional):</Text>
          <TextInput
            style={[styles.input, styles.descriptionInput]}
            value={description}
            onChangeText={setDescription}
            placeholder="e.g.: Used for concrete anchors or exposed ceiling conduit runs"
            placeholderTextColor="#99a"
            multiline
          />
          <TouchableOpacity style={styles.checkboxRow} onPress={() => setForceShowDescription((value) => !value)}>
            <Text style={styles.checkboxBox}>{forceShowDescription ? '☑' : '☐'}</Text>
            <Text style={styles.familyOptionText}>Always show description during selection</Text>
          </TouchableOpacity>
          <Text style={styles.helperText}>Check this for materials that need special instructions to be selected correctly, like specific drill bits or tools.</Text>

          <Text style={styles.label}>5. Category:</Text>
          <View style={styles.optionContainer}>
            {categories.map((cat) => (
              <TouchableOpacity key={cat} style={[styles.optionButton, category === cat && styles.optionButtonActive]} onPress={() => handleCategoryChange(cat)}>
                <Text style={[styles.optionText, category === cat && styles.optionTextActive]}>{cat.toUpperCase()}</Text>
              </TouchableOpacity>
            ))}

            {isOwner && (
              <TouchableOpacity
                style={[styles.optionButton, showAddCategory && { borderColor: '#64ffda' }]}
                onPress={() => setShowAddCategory(!showAddCategory)}
              >
                <Text style={[styles.optionText, { color: '#64ffda' }]}>+ NEW CATEGORY</Text>
              </TouchableOpacity>
            )}
          </View>

          {showAddCategory && isOwner && (
            <View style={styles.newCategoryBox}>
              <TextInput
                style={styles.input}
                value={newCategoryName}
                onChangeText={setNewCategoryName}
                placeholder="Enter new category name..."
                placeholderTextColor="#99a"
              />
              <TouchableOpacity
                style={[styles.btnSave, { backgroundColor: '#10b981', marginBottom: 12 }]}
                onPress={handleAddCategory}
                disabled={addingCategory}
              >
                {addingCategory ? <ActivityIndicator color="#fff" /> : <Text style={styles.btnSaveText}>CREATE CATEGORY</Text>}
              </TouchableOpacity>
              {canDeleteSelectedCategory && (
                <TouchableOpacity
                  style={[styles.btnSave, { backgroundColor: '#b91c1c', borderColor: '#ef4444', marginBottom: 20 }]}
                  onPress={handleDeleteCategory}
                  disabled={deletingCategory}
                >
                  {deletingCategory ? <ActivityIndicator color="#fff" /> : <Text style={styles.btnSaveText}>DELETE SELECTED CATEGORY</Text>}
                </TouchableOpacity>
              )}
              <Text style={styles.helperText}>Only Owner can create or delete custom categories. Default categories are protected.</Text>
            </View>
          )}

          <Text style={styles.label}>6. Units to Show:</Text>
          <View style={styles.optionContainer}>
            {[...unitOptions, 'Custom Unit'].map((unit) => (
              <TouchableOpacity key={unit} style={[styles.optionButton, allowedUnits.includes(unit) && styles.optionButtonActive]} onPress={() => toggleAllowedUnit(unit)}>
                <Text style={[styles.optionText, allowedUnits.includes(unit) && styles.optionTextActive]}>{unit.toUpperCase()}</Text>
              </TouchableOpacity>
            ))}
          </View>

          {showCustomUnitCreator ? (
            <View style={styles.newCategoryBox}>
              <Text style={styles.helperText}>Type a custom unit of measure, then press Add Custom Unit. Example: Bottle, Pack, Pair, Roll, Can.</Text>
              <TextInput
                style={styles.input}
                value={customUnitName}
                onChangeText={setCustomUnitName}
                placeholder="Custom unit name..."
                placeholderTextColor="#99a"
              />
              <TouchableOpacity style={[styles.btnSave, { backgroundColor: '#10b981', marginBottom: 15 }]} onPress={addCustomUnitToList}>
                <Text style={styles.btnSaveText}>ADD CUSTOM UNIT</Text>
              </TouchableOpacity>
            </View>
          ) : null}

          <Text style={styles.label}>7. Catalog Image (Optional):</Text>
          <View style={styles.imageCard}>
            {imageUri ? <Image source={{ uri: imageUri }} style={styles.previewImage} resizeMode="contain" /> : <View style={styles.emptyImageBox}><Text style={styles.emptyImageText}>No image selected</Text></View>}
            <View style={styles.imageButtonRow}>
              <TouchableOpacity style={styles.imageButton} onPress={pickImageFromLibrary}><Text style={styles.imageButtonText}>📁 Upload</Text></TouchableOpacity>
              <TouchableOpacity style={styles.imageButton} onPress={takePhotoWithCamera}><Text style={styles.imageButtonText}>📷 Camera</Text></TouchableOpacity>
            </View>
            {imageUri ? <TouchableOpacity style={styles.removeImageButton} onPress={() => setImageUri('')}><Text style={styles.removeImageText}>Remove Image</Text></TouchableOpacity> : null}
          </View>

          <Text style={styles.label}>7. Photo Options:</Text>
          <View style={styles.familyPickerCard}>
            <TouchableOpacity
              style={[styles.checkboxRow, showGroupCoverPicker && styles.checkboxRowActive]}
              onPress={() => setShowGroupCoverPicker(!showGroupCoverPicker)}
            >
              <Text style={styles.checkboxBox}>{showGroupCoverPicker ? '☑' : '☐'}</Text>
              <View style={{ flex: 1 }}>
                <Text style={[styles.familyOptionText, showGroupCoverPicker && styles.familyOptionTextActive]}>Add Group Cover Photo</Text>
                <Text style={styles.familyOptionSubText}>This photo represents the entire family in the catalog list.</Text>
              </View>
            </TouchableOpacity>

            {showGroupCoverPicker && (
              <View style={styles.imageCard}>
                {groupCoverUri ? <Image source={{ uri: groupCoverUri }} style={styles.previewImage} resizeMode="contain" /> : <View style={styles.emptyImageBox}><Text style={styles.emptyImageText}>No group cover selected</Text></View>}
                <View style={styles.imageButtonRow}>
                  <TouchableOpacity style={styles.imageButton} onPress={() => pickImageFromLibrary('group')}><Text style={styles.imageButtonText}>📁 Upload</Text></TouchableOpacity>
                  <TouchableOpacity style={styles.imageButton} onPress={() => takePhotoWithCamera('group')}><Text style={styles.imageButtonText}>📷 Camera</Text></TouchableOpacity>
                </View>
                {groupCoverUri ? <TouchableOpacity style={styles.removeImageButton} onPress={() => setGroupCoverUri('')}><Text style={styles.removeImageText}>Remove Group Cover</Text></TouchableOpacity> : null}
              </View>
            )}

            <TouchableOpacity
              style={[styles.checkboxRow, showIndividualImagePicker && styles.checkboxRowActive]}
              onPress={() => setShowIndividualImagePicker(!showIndividualImagePicker)}
            >
              <Text style={styles.checkboxBox}>{showIndividualImagePicker ? '☑' : '☐'}</Text>
              <View style={{ flex: 1 }}>
                <Text style={[styles.familyOptionText, showIndividualImagePicker && styles.familyOptionTextActive]}>Add Individual Material Photo</Text>
                <Text style={styles.familyOptionSubText}>This photo is unique to this material size/variant.</Text>
              </View>
            </TouchableOpacity>

            {showIndividualImagePicker && (
              <View style={styles.imageCard}>
                {imageUri ? <Image source={{ uri: imageUri }} style={styles.previewImage} resizeMode="contain" /> : <View style={styles.emptyImageBox}><Text style={styles.emptyImageText}>No material photo selected</Text></View>}
                <View style={styles.imageButtonRow}>
                  <TouchableOpacity style={styles.imageButton} onPress={() => pickImageFromLibrary('individual')}><Text style={styles.imageButtonText}>📁 Upload</Text></TouchableOpacity>
                  <TouchableOpacity style={styles.imageButton} onPress={() => takePhotoWithCamera('individual')}><Text style={styles.imageButtonText}>📷 Camera</Text></TouchableOpacity>
                </View>
                {imageUri ? <TouchableOpacity style={styles.removeImageButton} onPress={() => setImageUri('')}><Text style={styles.removeImageText}>Remove Material Photo</Text></TouchableOpacity> : null}
              </View>
            )}
          </View>

          <TouchableOpacity style={[styles.btnSave, saving && styles.btnDisabled]} onPress={handleSaveMaterial} disabled={saving}>
            {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.btnSaveText}>💾 SAVE TO FIREBASE CATALOG</Text>}
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a192f' },
  content: { padding: 20, paddingBottom: 80 },
  title: { fontSize: 16, fontWeight: '900', color: '#64ffda', textAlign: 'center', marginBottom: 20, letterSpacing: 1 },
  label: { color: '#e6f1ff', fontWeight: 'bold', marginBottom: 6, fontSize: 13, textTransform: 'uppercase' },
  helperText: { color: '#8892b0', fontSize: 12, marginTop: -8, marginBottom: 15 },
  descriptionInput: { minHeight: 85, textAlignVertical: 'top' },
  input: { backgroundColor: '#172a45', padding: 12, borderRadius: 8, borderWidth: 1, borderColor: '#303c55', color: '#e6f1ff', fontSize: 15, marginBottom: 15 },
  optionContainer: { flexDirection: 'row', flexWrap: 'wrap', marginBottom: 20, justifyContent: 'space-between' },
  optionButton: { backgroundColor: '#112240', paddingVertical: 10, paddingHorizontal: 6, borderRadius: 8, borderWidth: 1, borderColor: '#233554', marginBottom: 10, width: '48%', alignItems: 'center' },
  optionButtonActive: { backgroundColor: '#0275d8', borderColor: '#64ffda' },
  optionText: { color: '#8892b0', fontWeight: 'bold', fontSize: 10, textAlign: 'center' },
  optionTextActive: { color: '#fff' },
  previewCard: { backgroundColor: '#112240', borderRadius: 10, borderWidth: 1, borderColor: '#64ffda55', padding: 12, marginBottom: 18 },
  previewLabel: { color: '#8892b0', fontSize: 11, fontWeight: 'bold', textTransform: 'uppercase' },
  previewText: { color: '#64ffda', fontSize: 16, fontWeight: '900', marginTop: 4 },
  imageCard: { backgroundColor: '#112240', borderRadius: 12, borderWidth: 1, borderColor: '#233554', padding: 12, marginBottom: 22 },
  previewImage: { width: '100%', height: 210, borderRadius: 10, backgroundColor: '#172a45', marginBottom: 12 },
  emptyImageBox: { width: '100%', height: 160, borderRadius: 10, borderWidth: 1, borderStyle: 'dashed', borderColor: '#64ffda88', justifyContent: 'center', alignItems: 'center', marginBottom: 12 },
  emptyImageText: { color: '#8892b0', fontWeight: 'bold' },
  imageButtonRow: { flexDirection: 'row', justifyContent: 'space-between' },
  imageButton: { backgroundColor: '#172a45', padding: 12, borderRadius: 8, width: '48%', alignItems: 'center', borderWidth: 1, borderColor: '#303c55' },
  imageButtonText: { color: '#e6f1ff', fontWeight: 'bold' },
  removeImageButton: { marginTop: 12, alignItems: 'center' },
  removeImageText: { color: '#ff7675', fontWeight: 'bold' },
  btnSave: { backgroundColor: '#007bff', padding: 15, borderRadius: 10, alignItems: 'center', borderWidth: 1, borderColor: '#00d2ff' },
  btnDisabled: { opacity: 0.65 },
  btnSaveText: { color: '#fff', fontWeight: 'bold', fontSize: 15 },
  familyPickerCard: { backgroundColor: '#112240', borderRadius: 10, borderWidth: 1, borderColor: '#233554', padding: 10, marginBottom: 18 },
  checkboxRow: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: '#172a45', borderRadius: 8, borderWidth: 1, borderColor: '#303c55', padding: 10, marginBottom: 8 },
  checkboxRowActive: { backgroundColor: '#0275d8', borderColor: '#64ffda' },
  checkboxBox: { color: '#64ffda', fontSize: 18, fontWeight: '900' },
  newFamilyPanel: { borderLeftWidth: 3, borderLeftColor: '#64ffda', paddingLeft: 10, marginBottom: 8 },
  selectedFamilyPanel: { backgroundColor: '#0a192f', borderRadius: 8, borderWidth: 1, borderColor: '#64ffda66', padding: 10, marginBottom: 10 },
  familyOption: { backgroundColor: '#172a45', borderRadius: 8, borderWidth: 1, borderColor: '#303c55', padding: 10, marginBottom: 8 },
  suggestedFamilyOption: { borderColor: '#64ffda88' },
  familyOptionActive: { backgroundColor: '#0275d8', borderColor: '#64ffda' },
  familyOptionText: { color: '#e6f1ff', fontWeight: '800' },
  familyOptionTextActive: { color: '#fff' },
  familyOptionSubText: { color: '#8892b0', fontSize: 11, marginTop: 3 },
  newCategoryBox: {
    backgroundColor: '#112240',
    padding: 15,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#64ffda55',
    marginBottom: 20
  }
});

/**
 * DraftScreen
 * -----------
 * Main screen of the app. It contains the active Material Requirements,
 * project header fields, row consolidation, alphabetical sorting, deletion,
 * clearing, and sharing through the device share sheet.
 *
 * This screen intentionally stores only requisition data. Catalog photos and
 * catalog descriptions stay in the catalog so the final material list remains
 * simple and lightweight.
 */
import React, { useState, useEffect, useRef } from 'react';
import { StyleSheet, Text, View, TextInput, ScrollView, TouchableOpacity, Alert, ActivityIndicator, Share, Modal, BackHandler } from 'react-native';
import { StorageService } from '../database/storage';
import { StatusBar } from 'expo-status-bar';
import { useIsFocused } from '@react-navigation/native';
import { SafeAreaView } from 'react-native-safe-area-context';
import ViewShot from 'react-native-view-shot';
import * as Sharing from 'expo-sharing';
import * as Print from 'expo-print';
import * as FileSystem from 'expo-file-system/legacy';

export default function DraftScreen({ navigation, route, currentUser }) {
  const [buildingName, setBuildingName] = useState('');
  const [creatorName, setCreatorName] = useState('');
  const [items, setItems] = useState([]);
  const [isLoaded, setIsLoaded] = useState(false);
  const [mainMenuVisible, setMainMenuVisible] = useState(false);
  const [quantityImagePreviewVisible, setQuantityImagePreviewVisible] = useState(false);
  const [isGeneratingQuantityImage, setIsGeneratingQuantityImage] = useState(false);
  const [isGeneratingQuantityPdf, setIsGeneratingQuantityPdf] = useState(false);
  const quantitySheetImageRef = useRef(null);

  // One-time material states. These values are only used for the active requisition.
  // They are never sent to Firebase and never become part of the shared catalog.
  const [oneTimeModalVisible, setOneTimeModalVisible] = useState(false);
  const [oneTimeName, setOneTimeName] = useState('');
  const [oneTimeQuantity, setOneTimeQuantity] = useState('1');
  const [oneTimeUnit, setOneTimeUnit] = useState('Unit');
  const [oneTimeNote, setOneTimeNote] = useState('');

  // Edit states for existing materials in the sheet
  const [editModalVisible, setEditModalVisible] = useState(false);
  const [editingIndex, setEditingIndex] = useState(null);
  const [editQuantity, setEditQuantity] = useState('1');
  const [editUnit, setEditUnit] = useState('Unit');
  const [editLengthDetail, setEditLengthDetail] = useState('');
  const [editNote, setEditNote] = useState('');

  const isFocused = useIsFocused();

  // Returns the current signed-in username used for the Created By field.
  // Registered users get their own username/name. Guest users intentionally
  // start blank so they can type a temporary name for that requisition only.
  const getCurrentCreatorDefault = () => {
    if (currentUser?.isGuest) return '';
    return currentUser?.username || currentUser?.displayName || currentUser?.email?.split('@')[0] || '';
  };

  // This key prevents a new signed-in user from seeing the previous user's
  // Created By value on a shared device. Guest drafts keep their own manual
  // value during the guest session.
  const getCurrentCreatorSessionKey = () => {
    if (currentUser?.isGuest) return 'guest';
    return currentUser?.uid || currentUser?.email || 'registered-user';
  };

  // Opens a future-friendly menu from the main screen. New app windows can be
  // added here without filling the Draft screen with too many separate buttons.
  const openMenuScreen = (screenName) => {
    setMainMenuVisible(false);
    if (screenName === 'OneTimeMaterial') {
      setOneTimeModalVisible(true);
      return;
    }

    // The Draft screen is the root of the app. Opening tools from here should
    // add only one secondary screen to the stack. If the user returns with the
    // device Back button, that screen is removed and Draft remains as the only
    // page left before the app asks to exit.
    navigation.navigate(screenName);
  };

  // Handles the Android system Back button on the main screen.
  // If a modal is open, Back closes it first. If no modal is open, the user is
  // asked before exiting the app so the active Material Requirements is not
  // lost by accident. The temporary requisition still remains saved locally
  // until the user manually clears the table.
  useEffect(() => {
    const handleDeviceBack = () => {
      if (mainMenuVisible) {
        setMainMenuVisible(false);
        return true;
      }

      if (quantityImagePreviewVisible) {
        setQuantityImagePreviewVisible(false);
        return true;
      }

      if (oneTimeModalVisible) {
        setOneTimeModalVisible(false);
        return true;
      }

      if (editModalVisible) {
        setEditModalVisible(false);
        return true;
      }

      Alert.alert(
        'Exit App?',
        currentUser?.isGuest
          ? 'Guest drafts are temporary and may be lost when the app is closed. Sign in or create an account if you want to keep your active draft.'
          : 'Your current Material Requirements will stay saved only for your account on this device until you clear it manually.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Exit', style: 'destructive', onPress: () => BackHandler.exitApp() }
        ]
      );
      return true;
    };

    const subscription = BackHandler.addEventListener('hardwareBackPress', handleDeviceBack);
    return () => subscription.remove();
  }, [mainMenuVisible, quantityImagePreviewVisible, oneTimeModalVisible, editModalVisible, currentUser]);

  // Helper function that sorts material rows alphabetically by material name. This keeps the exported list clean and predictable.
  const sortItemsByName = (array) => {
    return [...array].sort((a, b) => {
      const nameA = a.material?.name?.toLowerCase() || '';
      const nameB = b.material?.name?.toLowerCase() || '';
      return nameA.localeCompare(nameB);
    });
  };

  const isLengthUnit = (unit) => unit === 'Length (ft)' || unit === 'Length (in)';

  const getDisplayUnit = (unit, quantity) => {
    if (unit === 'Reel') {
      return quantity === 1 ? 'Reel' : 'Reels';
    }
    if (isLengthUnit(unit)) {
      return unit === 'Length (in)' ? 'Length (in)' : 'Length (ft)';
    }
    return unit;
  };

  const getLengthDisplayText = (item) => {
    const rawValue = String(item?.lengthDetail || '').trim();
    if (!rawValue) return item?.unit === 'Length (in)' ? 'Length in inches not specified' : 'Length in feet not specified';
    const lowerValue = rawValue.toLowerCase();
    const numericMatch = lowerValue.match(/\d+(?:\.\d+)?/);
    const numberText = numericMatch ? numericMatch[0] : rawValue;
    if (item?.unit === 'Length (in)') return `${numberText} in`;
    return `${numberText} ft`;
  };

  const getLengthMessageText = (item) => {
    const displayLength = getLengthDisplayText(item);
    return `Length: ${displayLength} long`;
  };

  // Loads the saved draft from local device storage.
  const loadSavedData = async () => {
    try {
      const currentUserName = getCurrentCreatorDefault();
      const currentCreatorSessionKey = getCurrentCreatorSessionKey();
      const saved = await StorageService.loadDraft(currentCreatorSessionKey);

      if (saved) {
        setBuildingName(saved.buildingName || '');

        // If the saved draft belongs to the same current session, keep the
        // manually edited Created By value. If another user signed in on this
        // device, replace it with that user's own username/name.
        const savedBelongsToCurrentSession = saved.creatorSessionKey === currentCreatorSessionKey;
        const nextCreatorName = savedBelongsToCurrentSession
          ? (saved.creatorName || currentUserName)
          : currentUserName;

        setCreatorName(nextCreatorName);

        const sortedItems = sortItemsByName(saved.items || []);
        setItems(sortedItems);

        if (!savedBelongsToCurrentSession || saved.creatorName !== nextCreatorName) {
          await StorageService.saveDraft({
            buildingName: saved.buildingName || '',
            creatorName: nextCreatorName,
            creatorSessionKey: currentCreatorSessionKey,
            items: sortedItems
          });
        }
      } else {
        setCreatorName(currentUserName);
        await StorageService.saveDraft({
          buildingName: '',
          creatorName: currentUserName,
          creatorSessionKey: currentCreatorSessionKey,
          items: []
        });
      }
    } catch (e) {
      console.error("Error loading local draft:", e);
    } finally {
      setIsLoaded(true);
    }
  };

  // 1. Reload the saved draft every time the main screen becomes focused. This keeps the UI synchronized after returning from other screens.
  useEffect(() => {
    if (isFocused) {
      loadSavedData();
    }
  }, [isFocused, currentUser?.uid, currentUser?.username, currentUser?.displayName, currentUser?.isGuest]);

  // Adds one incoming material into the current draft array.
  // This helper is shared by single selection and multiple selection so duplicate consolidation stays consistent.
  const mergeIncomingItemIntoDraft = (baseItems, incomingItem) => {
    const { material, quantity, unit, lengthDetail, description } = incomingItem;

    const incomingQuantity = parseInt(quantity, 10) || 1;
    const incomingUnit = unit || 'Unit';
    const incomingLength = lengthDetail || '';
    const incomingDescription = description || '';

    // Duplicate check by material name, unit, and length detail.
    // This means selecting the same THHN color twice with the same unit will increase the quantity instead of creating duplicates.
    const existingItemIndex = baseItems.findIndex(item =>
      item.material?.name?.toLowerCase() === material?.name?.toLowerCase() &&
      item.unit?.toLowerCase() === incomingUnit.toLowerCase() &&
      item.lengthDetail?.toLowerCase() === incomingLength.toLowerCase()
    );

    if (existingItemIndex !== -1) {
      const updatedItems = [...baseItems];
      updatedItems[existingItemIndex] = {
        ...updatedItems[existingItemIndex],
        quantity: updatedItems[existingItemIndex].quantity + incomingQuantity,
        description: incomingDescription.trim()
          ? `${updatedItems[existingItemIndex].description} | ${incomingDescription}`.replace(/^ \| /, '')
          : updatedItems[existingItemIndex].description
      };
      return updatedItems;
    }

    const freshItem = {
      material,
      quantity: incomingQuantity,
      unit: incomingUnit,
      lengthDetail: incomingLength,
      description: incomingDescription
    };

    return [...baseItems, freshItem];
  };

  // 2. Detect incoming materials, consolidate duplicates, and sort the table alphabetically before saving.
  // CatalogScreen can now send either one material through route.params.newItem or several materials through route.params.newItems.
  useEffect(() => {
    const processIncomingItems = async () => {
      const incomingItems = route.params?.newItems || (route.params?.newItem ? [route.params.newItem] : []);

      if (incomingItems.length === 0) return;

      try {
        // We load the actual list stored in the device storage so multiple additions do not overwrite recent changes.
        const currentSavedDraft = await StorageService.loadDraft(getCurrentCreatorSessionKey());
        let updatedItems = currentSavedDraft?.items || [];

        // Each selected catalog material is merged one by one using the same duplicate rules.
        incomingItems.forEach((incomingItem) => {
          updatedItems = mergeIncomingItemIntoDraft(updatedItems, incomingItem);
        });

        // We sort the entire list alphabetically before updating UI and local storage.
        const sortedItems = sortItemsByName(updatedItems);
        setItems(sortedItems);

        await StorageService.saveDraft({
          buildingName: currentSavedDraft?.buildingName || buildingName,
          creatorName: currentSavedDraft?.creatorName || creatorName,
          creatorSessionKey: currentSavedDraft?.creatorSessionKey || getCurrentCreatorSessionKey(),
          items: sortedItems
        });
      } catch (error) {
        console.error('Error consolidating and sorting materials:', error);
      }

      // Clear navigation parameters so the same material or group is not added again when the screen re-renders.
      navigation.setParams({ newItem: undefined, newItems: undefined });
    };

    processIncomingItems();
  }, [route.params?.newItem, route.params?.newItems]);

  // Save header fields immediately while the user types so project information is not lost.
  const handleTextChange = async (type, text) => {
    let latestBuilding = buildingName;
    let latestCreator = creatorName;

    if (type === 'building') {
      setBuildingName(text);
      latestBuilding = text;
    } else {
      setCreatorName(text);
      latestCreator = text;
    }

    await StorageService.saveDraft({ buildingName: latestBuilding, creatorName: latestCreator, creatorSessionKey: getCurrentCreatorSessionKey(), items });
  };

  // Delete one row from the spreadsheet-style material table and immediately update local storage.
  const deleteItem = async (indexToDelete) => {
    const updated = items.filter((_, idx) => idx !== indexToDelete);
    setItems(updated);
    await StorageService.saveDraft({ buildingName, creatorName, creatorSessionKey: getCurrentCreatorSessionKey(), items: updated });
  };

  // Opens the edit modal for an existing item
  const startEditing = (index) => {
    const item = items[index];
    setEditingIndex(index);
    setEditQuantity(String(item.quantity));
    setEditUnit(item.unit || 'Unit');
    setEditLengthDetail(item.lengthDetail || '');
    setEditNote(item.description || '');
    setEditModalVisible(true);
  };

  // Saves the changes from the edit modal
  const saveEdit = async () => {
    if (editingIndex === null) return;

    const updatedItems = [...items];
    const qty = parseInt(editQuantity, 10);

    if (isNaN(qty) || qty <= 0) {
      Alert.alert('Invalid Quantity', 'Please enter a valid number greater than 0.');
      return;
    }

    updatedItems[editingIndex] = {
      ...updatedItems[editingIndex],
      quantity: qty,
      unit: editUnit,
      lengthDetail: (editUnit === 'Length (ft)' || editUnit === 'Length (in)' || editUnit === 'Reel') ? editLengthDetail : '',
      description: editNote.trim()
    };

    setItems(updatedItems);
    await StorageService.saveDraft({
      buildingName,
      creatorName,
      creatorSessionKey: getCurrentCreatorSessionKey(),
      items: updatedItems
    });

    setEditModalVisible(false);
    setEditingIndex(null);
  };

  const incrementEditQuantity = () => {
    const current = parseInt(editQuantity, 10) || 1;
    setEditQuantity(String(current + 1));
  };

  const decrementEditQuantity = () => {
    const current = parseInt(editQuantity, 10) || 1;
    setEditQuantity(String(Math.max(1, current - 1)));
  };

  const incrementOneTimeQuantity = () => {
    const current = parseInt(oneTimeQuantity, 10) || 1;
    setOneTimeQuantity(String(current + 1));
  };

  const decrementOneTimeQuantity = () => {
    const current = parseInt(oneTimeQuantity, 10) || 1;
    setOneTimeQuantity(String(Math.max(1, current - 1)));
  };

  // Adds a one-time material directly to the current Material Requirements.
  // This is useful when a material is needed once but should not be saved in the global Firebase catalog.
  const addOneTimeMaterialToList = async () => {
    const cleanName = oneTimeName.trim();

    if (!cleanName) {
      Alert.alert('Required Field', 'Please enter the one-time material name.');
      return;
    }

    const quantityValue = parseInt(oneTimeQuantity, 10) || 1;
    const temporaryMaterial = {
      id: `one-time-${Date.now()}`,
      name: cleanName,
      category: 'One-Time Material',
      size: 'N/A',
      description: '',
      imageUri: '',
      keywords: [],
      isOneTime: true
    };

    const freshItem = {
      material: temporaryMaterial,
      quantity: quantityValue,
      unit: oneTimeUnit || 'Unit',
      lengthDetail: '',
      description: oneTimeNote.trim()
    };

    const updatedItems = sortItemsByName([...items, freshItem]);
    setItems(updatedItems);
    await StorageService.saveDraft({ buildingName, creatorName, creatorSessionKey: getCurrentCreatorSessionKey(), items: updatedItems });

    setOneTimeName('');
    setOneTimeQuantity('1');
    setOneTimeUnit('Unit');
    setOneTimeNote('');
    setOneTimeModalVisible(false);
  };


  // Clear the material list completely
  const clearList = () => {
    Alert.alert("Clear Table", "Are you sure you want to clear the entire current material list?", [
      { text: "Cancel" },
      { text: "Yes, Clear", style: 'destructive', onPress: async () => {
          setItems([]);
          await StorageService.saveDraft({ buildingName, creatorName, creatorSessionKey: getCurrentCreatorSessionKey(), items: [] });
        }
      }
    ]);
  };

  // Opens a clean image preview before sharing the Material Requirements.
  // The working table remains unchanged; only the generated document is shared.
  const openQuantityImagePreview = () => {
    if (items.length === 0) {
      Alert.alert('Empty Table', 'Please add materials before generating the image.');
      return;
    }
    setQuantityImagePreviewVisible(true);
  };

  const escapeReportHtml = (value) => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');

  const buildMaterialRequirementsPdfHtml = () => {
    const rows = items.map((item, index) => {
      const detailParts = [];
      if (item.lengthDetail) detailParts.push(isLengthUnit(item.unit) ? getLengthDisplayText(item) : item.lengthDetail);
      if (item.description) detailParts.push(item.description);
      const quantity = isLengthUnit(item.unit) ? '—' : item.quantity;
      const unit = isLengthUnit(item.unit) ? getLengthDisplayText(item) : getDisplayUnit(item.unit, item.quantity);
      return `
        <tr>
          <td class="number">${index + 1}</td>
          <td class="description"><strong>${escapeReportHtml(item.material?.name || 'Material')}</strong>${detailParts.length ? `<small>${escapeReportHtml(detailParts.join(' • '))}</small>` : ''}</td>
          <td class="qty">${escapeReportHtml(quantity)}</td>
          <td class="unit">${escapeReportHtml(unit)}</td>
        </tr>`;
    }).join('');

    return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>
      @page { size: Letter; margin: 24px; }
      * { box-sizing: border-box; }
      body { margin: 0; font-family: Arial, Helvetica, sans-serif; color: #111827; background: #fff; }
      .document { border: 1px solid #94a3b8; border-radius: 10px; overflow: hidden; }
      .hero { min-height: 112px; background: #052a4a; color: white; padding: 20px 24px; display: flex; align-items: center; justify-content: space-between; }
      .hero h1 { margin: 0; max-width: 78%; font-size: 30px; line-height: 1.05; font-weight: 900; letter-spacing: .4px; }
      .underline { width: 92px; height: 4px; margin-top: 10px; background: #0ea5e9; }
      .icon { width: 90px; text-align: center; color: #38bdf8; font-weight: 900; font-size: 11px; }
      .icon .bolt { font-size: 42px; display: block; }
      .meta { padding: 18px 24px 8px; }
      .meta-label { color: #092f55; font-size: 12px; font-weight: 900; margin-top: 8px; }
      .meta-value { min-height: 28px; padding: 5px 2px; border-bottom: 1px solid #94a3b8; font-size: 14px; }
      .table-wrap { margin: 16px 18px 22px; border: 1px solid #94a3b8; border-radius: 8px; overflow: hidden; }
      .section-title { background: #052a4a; color: #fff; text-align: center; font-size: 18px; font-weight: 900; padding: 10px; }
      table { width: 100%; border-collapse: collapse; table-layout: fixed; }
      th { background: #07345d; color: #fff; font-size: 11px; font-weight: 900; padding: 10px 6px; border-right: 1px solid #94a3b8; border-bottom: 2px solid #94a3b8; }
      td { min-height: 44px; padding: 10px 7px; font-size: 12px; text-align: center; border-right: 1px solid #94a3b8; border-bottom: 2px solid #94a3b8; overflow-wrap: anywhere; }
      tr:last-child td { border-bottom: 0; }
      th:last-child, td:last-child { border-right: 0; }
      .number { width: 15%; font-weight: 900; }
      td.number { color: #0b4a83; }
      .description { width: 49%; text-align: left; }
      .description strong { display: block; font-size: 12px; }
      .description small { display: block; color: #475569; font-size: 10px; margin-top: 3px; }
      .qty { width: 14%; }
      .unit { width: 22%; }
      thead { display: table-header-group; }
      tr { page-break-inside: avoid; }
    </style></head><body><div class="document">
      <div class="hero"><div><h1>MATERIAL REQUIREMENTS</h1><div class="underline"></div></div><div class="icon"><span class="bolt">⚡</span>MATERIALS</div></div>
      <div class="meta"><div class="meta-label">▣ PROJECT / JOB NAME:</div><div class="meta-value">${escapeReportHtml(buildingName || ' ')}</div><div class="meta-label">● REQUESTED BY:</div><div class="meta-value">${escapeReportHtml(creatorName || ' ')}</div></div>
      <div class="table-wrap"><div class="section-title">MATERIAL REQUIREMENTS</div><table><thead><tr><th class="number">ITEM NO.</th><th class="description">ITEM DESCRIPTION</th><th class="qty">QTY.</th><th class="unit">UNIT</th></tr></thead><tbody>${rows}</tbody></table></div>
    </div></body></html>`;
  };

  const shareMaterialRequirementsPdf = async () => {
    if (!items.length) {
      Alert.alert('Empty Table', 'Please add materials before generating the PDF.');
      return;
    }
    setIsGeneratingQuantityPdf(true);
    try {
      const { base64: pdfBase64 } = await Print.printToFileAsync({
        html: buildMaterialRequirementsPdfHtml(),
        base64: true,
      });

      // Expo Go can return a temporary Print URI that FileSystem and Sharing
      // cannot read. The returned base64 lets us create a fresh PDF inside the
      // app cache without trying to copy that inaccessible temporary file.
      if (!pdfBase64) {
        throw new Error('MATERIAL_REQUIREMENTS_PDF_BASE64_MISSING');
      }

      const shareableUri = `${FileSystem.cacheDirectory}material-requirements-${Date.now()}.pdf`;
      await FileSystem.writeAsStringAsync(shareableUri, pdfBase64, {
        encoding: FileSystem.EncodingType.Base64,
      });

      const pdfInfo = await FileSystem.getInfoAsync(shareableUri, { size: true });
      if (!pdfInfo.exists || !pdfInfo.size) {
        throw new Error('MATERIAL_REQUIREMENTS_PDF_CACHE_WRITE_FAILED');
      }

      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(shareableUri, {
          mimeType: 'application/pdf',
          dialogTitle: 'Share material requirements PDF',
          UTI: 'com.adobe.pdf',
        });
      } else {
        Alert.alert('PDF created', `The PDF was created at: ${shareableUri}`);
      }
    } catch (error) {
      console.error('Error generating material requirements PDF:', error);
      Alert.alert('Unable to generate PDF', 'Confirm that expo-print and expo-sharing are installed, then rebuild or restart the app.');
    } finally {
      setIsGeneratingQuantityPdf(false);
    }
  };

  const shareQuantitySheetImage = async () => {
    if (!quantitySheetImageRef.current) return;
    setIsGeneratingQuantityImage(true);
    try {
      // Give the modal one frame to finish laying out before capture.
      await new Promise((resolve) => setTimeout(resolve, 180));
      const uri = await quantitySheetImageRef.current.capture();
      if (!uri) throw new Error('QUANTITY_IMAGE_CAPTURE_FAILED');

      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(uri, {
          mimeType: 'image/png',
          dialogTitle: 'Share material quantity sheet',
          UTI: 'public.png',
        });
      } else {
        const message = `Material Requirements\nProject: ${buildingName || 'Not specified'}\nRequested by: ${creatorName || 'Not specified'}`;
        await Share.share({ message });
      }
    } catch (error) {
      console.error('Error generating quantity sheet image:', error);
      Alert.alert(
        'Unable to generate image',
        'Confirm that react-native-view-shot and expo-sharing are installed, then rebuild or restart the app.'
      );
    } finally {
      setIsGeneratingQuantityImage(false);
    }
  };

  if (!isLoaded) {
    return (
      <SafeAreaView style={[styles.container, { justifyContent: 'center', alignItems: 'center' }]} edges={['left', 'right', 'bottom']}>
        <ActivityIndicator size="large" color="#64ffda" />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['top', 'left', 'right', 'bottom']}>
      <StatusBar style="light" />

      <View style={styles.customHeader}>
        <View style={styles.headerLeftSpacer} />
        <Text style={styles.customHeaderTitle}>Material Requisition</Text>
        <TouchableOpacity style={styles.headerMenuButton} onPress={() => setMainMenuVisible(true)}>
          <Text style={styles.headerMenuText}>☰</Text>
        </TouchableOpacity>
      </View>

      <ScrollView style={styles.content} contentContainerStyle={{ paddingBottom: 40 }}>

        {/* Data Control Header */}
        <View style={styles.section}>
          <Text style={styles.label}>Project / Building:</Text>
          <TextInput
            style={styles.input}
            value={buildingName}
            onChangeText={(t) => handleTextChange('building', t)}
            placeholder="e.g.: North Tower - 3rd Floor"
            placeholderTextColor="#99a"
          />

          <Text style={styles.label}>Created By:</Text>
          <TextInput
            style={styles.input}
            value={creatorName}
            onChangeText={(t) => handleTextChange('creator', t)}
            placeholder="e.g.: Technical Installer"
            placeholderTextColor="#99a"
          />
          <Text style={styles.helperText}>
            {currentUser?.isGuest
              ? 'Guest mode: this draft is temporary and can be lost after closing the app. Sign in if you want the draft to stay saved.'
              : 'Auto-filled from your signed-in account. You can still edit it for this requisition.'}
          </Text>
        </View>

        {/* EXCEL-STYLE HORIZONTAL TABLE DESIGN */}
        <View style={styles.tableCard}>
          <Text style={styles.tableTitle}>MATERIAL REQUIREMENTS</Text>

          {/* Horizontal Cell Header */}
          <View style={styles.tableHeader}>
            <Text style={[styles.headerCell, { flex: 2.2 }]}>Material / Description</Text>
            <Text style={[styles.headerCell, { flex: 0.8, textAlign: 'center' }]}>Qty.</Text>
            <Text style={[styles.headerCell, { flex: 1.0, textAlign: 'center' }]}>Unit</Text>
            <Text style={[styles.headerCell, { flex: 1.4 }]}>Note / Destination</Text>
            <Text style={[styles.headerCell, { width: 70, textAlign: 'center' }]}>Actions</Text>
          </View>

          {/* Table Data Rows */}
          {items.length === 0 ? (
            <Text style={styles.emptyText}>The table is empty. Press the button below to search and add materials.</Text>
          ) : (
            items.map((item, index) => (
              <View key={index} style={styles.row}>
                {/* Cell 1: Description and foot (ft) specification */}
                <View style={{ flex: 2.2, paddingRight: 4 }}>
                  <Text style={styles.cellMaterialName}>{item.material?.name}</Text>
                  {item.lengthDetail ? (
                    <Text style={styles.cellLengthDetail}>📍 {isLengthUnit(item.unit) ? getLengthDisplayText(item) : item.lengthDetail}</Text>
                  ) : null}
                </View>

                {/* Cell 2: Unified quantity. Length rows are one material with a measured length, not a counted quantity. */}
                <Text style={[styles.cellText, { flex: 0.8, textAlign: 'center', fontWeight: 'bold', color: '#007bff' }]}>
                  {isLengthUnit(item.unit) ? '—' : item.quantity}
                </Text>

                {/* Cell 3: Selected unit */}
                <Text style={[styles.cellText, { flex: 1.0, textAlign: 'center', color: '#555', fontSize: 12 }]}>
                  {isLengthUnit(item.unit) ? getLengthDisplayText(item) : getDisplayUnit(item.unit, item.quantity)}
                </Text>

                {/* Cell 4: Combined notes */}
                <Text style={[styles.cellText, { flex: 1.4, fontSize: 12, color: '#666', fontStyle: 'italic' }]} numberOfLines={2}>
                  {item.description || '-'}
                </Text>

                {/* Cell 5: Actions */}
                <View style={styles.actionCell}>
                  <TouchableOpacity onPress={() => startEditing(index)} style={styles.btnEditRow}>
                    <Text style={styles.btnEditRowText}>✎</Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => deleteItem(index)} style={styles.btnDeleteRow}>
                    <Text style={styles.btnDeleteRowText}>✕</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ))
          )}
        </View>

        {/* Actions and Screen Interconnection */}
        <TouchableOpacity
          style={styles.btnPrimary}
          onPress={() => navigation.navigate('Catalog')}
        >
          <Text style={styles.btnText}>🔍 OPEN CATALOG AND SEARCH</Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.menuButton} onPress={() => setOneTimeModalVisible(true)}>
          <Text style={styles.btnText}>➕ ADD ONE-TIME MATERIAL</Text>
        </TouchableOpacity>

        {items.length > 0 && (
          <View>
            <TouchableOpacity style={styles.btnShare} onPress={openQuantityImagePreview}>
              <Text style={styles.btnText}>🖼️ PREVIEW & SHARE MATERIAL IMAGE</Text>
            </TouchableOpacity>

            <TouchableOpacity style={[styles.btnPdf, isGeneratingQuantityPdf && styles.quantityPreviewButtonDisabled]} onPress={shareMaterialRequirementsPdf} disabled={isGeneratingQuantityPdf}>
              <Text style={styles.btnText}>{isGeneratingQuantityPdf ? 'GENERATING PDF...' : '📄 GENERATE & SHARE PDF'}</Text>
            </TouchableOpacity>

            <TouchableOpacity style={styles.btnDanger} onPress={clearList}>
              <Text style={styles.btnText}>⚠️ CLEAR ENTIRE TABLE</Text>
            </TouchableOpacity>
          </View>
        )}
      </ScrollView>

      {/* Material Requirements image preview. The ViewShot captures only this clean document. */}
      <Modal
        visible={quantityImagePreviewVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setQuantityImagePreviewVisible(false)}
      >
        <View style={styles.quantityPreviewOverlay}>
          <SafeAreaView style={styles.quantityPreviewSafeArea} edges={['top', 'bottom']}>
            <View style={styles.quantityPreviewCard}>
              <View style={styles.quantityPreviewTopBar}>
                <View style={{ width: 42 }} />
                <Text style={styles.quantityPreviewTitle}>Material Image Preview</Text>
                <TouchableOpacity
                  style={styles.quantityPreviewClose}
                  onPress={() => setQuantityImagePreviewVisible(false)}
                >
                  <Text style={styles.quantityPreviewCloseText}>✕</Text>
                </TouchableOpacity>
              </View>

              <ScrollView
                style={styles.quantityPreviewScroll}
                contentContainerStyle={styles.quantityPreviewScrollContent}
                showsVerticalScrollIndicator
              >
                <ViewShot
                  ref={quantitySheetImageRef}
                  options={{ format: 'png', quality: 1, result: 'tmpfile' }}
                  style={styles.quantityCaptureWrapper}
                >
                  <View style={styles.quantityDocument}>
                    <View style={styles.quantityDocumentHero}>
                      <View style={styles.quantityDocumentHeroTextWrap}>
                        <Text
                          style={styles.quantityDocumentHeroTitle}
                          numberOfLines={2}
                          adjustsFontSizeToFit
                          minimumFontScale={0.7}
                        >
                          MATERIAL REQUIREMENTS
                        </Text>
                        <View style={styles.quantityDocumentUnderline} />
                      </View>
                      <View style={styles.quantityDocumentIconWrap}>
                        <Text style={styles.quantityDocumentIcon}>⚡</Text>
                        <Text style={styles.quantityDocumentIconLabel}>MATERIALS</Text>
                      </View>
                    </View>

                    <View style={styles.quantityDocumentMeta}>
                      <Text style={styles.quantityDocumentMetaLabel}>▣  PROJECT / JOB NAME:</Text>
                      <Text style={styles.quantityDocumentMetaValue}>{buildingName || ' '}</Text>
                      <Text style={styles.quantityDocumentMetaLabel}>●  REQUESTED BY:</Text>
                      <Text style={styles.quantityDocumentMetaValue}>{creatorName || ' '}</Text>
                    </View>

                    <View style={styles.quantityDocumentTable}>
                      <View style={styles.quantityDocumentSectionTitle}>
                        <Text style={styles.quantityDocumentSectionTitleText}>MATERIAL REQUIREMENTS</Text>
                      </View>
                      <View style={styles.quantityDocumentTableHeader}>
                        <Text style={[styles.quantityDocHeaderCell, styles.quantityDocNumberColumn]}>ITEM NO.</Text>
                        <Text style={[styles.quantityDocHeaderCell, styles.quantityDocDescriptionColumn]}>ITEM DESCRIPTION</Text>
                        <Text style={[styles.quantityDocHeaderCell, styles.quantityDocQtyColumn]}>QTY.</Text>
                        <Text style={[styles.quantityDocHeaderCell, styles.quantityDocUnitColumn]}>UNIT</Text>
                      </View>
                      {items.map((item, index) => {
                        const detailParts = [];
                        if (item.lengthDetail) {
                          detailParts.push(isLengthUnit(item.unit) ? getLengthDisplayText(item) : item.lengthDetail);
                        }
                        if (item.description) detailParts.push(item.description);
                        return (
                          <View key={`quantity-image-${index}`} style={styles.quantityDocumentTableRow}>
                            <Text style={[styles.quantityDocBodyCell, styles.quantityDocNumberColumn, styles.quantityDocItemNumber]}>{index + 1}</Text>
                            <View style={[styles.quantityDocDescriptionBody, styles.quantityDocDescriptionColumn]}>
                              <Text style={styles.quantityDocMaterialName}>{item.material?.name || 'Material'}</Text>
                              {!!detailParts.length && <Text style={styles.quantityDocMaterialDetail}>{detailParts.join(' • ')}</Text>}
                            </View>
                            <Text style={[styles.quantityDocBodyCell, styles.quantityDocQtyColumn]}>{isLengthUnit(item.unit) ? '—' : item.quantity}</Text>
                            <Text style={[styles.quantityDocBodyCell, styles.quantityDocUnitColumn]}>
                              {isLengthUnit(item.unit) ? getLengthDisplayText(item) : getDisplayUnit(item.unit, item.quantity)}
                            </Text>
                          </View>
                        );
                      })}
                    </View>
                  </View>
                </ViewShot>
              </ScrollView>

              <View style={styles.quantityPreviewActions}>
                <TouchableOpacity
                  style={styles.quantityPreviewCancelButton}
                  onPress={() => setQuantityImagePreviewVisible(false)}
                >
                  <Text style={styles.quantityPreviewCancelText}>Close</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.quantityPreviewShareButton, isGeneratingQuantityImage && styles.quantityPreviewButtonDisabled]}
                  onPress={shareQuantitySheetImage}
                  disabled={isGeneratingQuantityImage}
                >
                  <Text style={styles.quantityPreviewShareText}>
                    {isGeneratingQuantityImage ? 'Generating...' : 'Share Image'}
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.quantityPreviewPdfButton, isGeneratingQuantityPdf && styles.quantityPreviewButtonDisabled]}
                  onPress={shareMaterialRequirementsPdf}
                  disabled={isGeneratingQuantityPdf}
                >
                  <Text style={styles.quantityPreviewShareText}>
                    {isGeneratingQuantityPdf ? 'Generating...' : 'Share PDF'}
                  </Text>
                </TouchableOpacity>
              </View>
            </View>
          </SafeAreaView>
        </View>
      </Modal>

      {/* One-Time Material Modal
          This modal creates a temporary row only for the current requisition.
          It does not call StorageService.addMaterial, so nothing is saved to Firebase. */}
      <Modal visible={mainMenuVisible} transparent animationType="fade" onRequestClose={() => setMainMenuVisible(false)}>
        <View style={styles.menuOverlay}>
          <View style={styles.menuContent}>
            <TouchableOpacity style={styles.menuCloseIconButton} onPress={() => setMainMenuVisible(false)}>
              <Text style={styles.menuCloseIconText}>✕</Text>
            </TouchableOpacity>
            <Text style={styles.menuTitle}>More Options</Text>
            <Text style={styles.menuSubtitle}>Extra windows and future tools will live here.</Text>

            <TouchableOpacity style={styles.menuOption} onPress={() => openMenuScreen('CatalogManager')}>
              <Text style={styles.menuOptionText}>🛠️ Manage Catalog</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.menuOption} onPress={() => openMenuScreen('ImportantInfo')}>
              <Text style={styles.menuOptionText}>🖼️ Important Info</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.menuOption} onPress={() => openMenuScreen('CableRequirements')}>
              <Text style={styles.menuOptionText}>🧾 Cable & Wire Requirements</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.menuOption} onPress={() => openMenuScreen('Profile')}>
              <Text style={styles.menuOptionText}>👤 User Profile</Text>
            </TouchableOpacity>

          </View>
        </View>
      </Modal>

      <Modal visible={oneTimeModalVisible} transparent animationType="fade" onRequestClose={() => setOneTimeModalVisible(false)}>
        <View style={styles.modalOverlay}>
          <SafeAreaView style={styles.modalSafeArea}>
            <View style={styles.modalContent}>
              <TouchableOpacity style={styles.menuCloseIconButton} onPress={() => setOneTimeModalVisible(false)}>
                <Text style={styles.menuCloseIconText}>✕</Text>
              </TouchableOpacity>
              <Text style={styles.modalTitle}>ADD ONE-TIME MATERIAL</Text>
              <Text style={styles.modalHelpText}>Use this for a material that should appear only in this requisition, not in the global catalog.</Text>

              <Text style={styles.modalLabel}>Material Name:</Text>
              <TextInput
                style={styles.modalInput}
                value={oneTimeName}
                onChangeText={setOneTimeName}
                placeholder="e.g.: Special adapter requested once"
                placeholderTextColor="#777"
              />

              <Text style={styles.modalLabel}>Quantity:</Text>
              <View style={styles.quantityStepper}>
                <TouchableOpacity style={styles.quantityButton} onPress={decrementOneTimeQuantity}>
                  <Text style={styles.quantityButtonText}>−</Text>
                </TouchableOpacity>
                <TextInput
                  style={[styles.modalInput, styles.quantityInput]}
                  keyboardType="numeric"
                  value={oneTimeQuantity}
                  onChangeText={setOneTimeQuantity}
                  textAlign="center"
                />
                <TouchableOpacity style={styles.quantityButton} onPress={incrementOneTimeQuantity}>
                  <Text style={styles.quantityButtonText}>+</Text>
                </TouchableOpacity>
              </View>

              <Text style={styles.modalLabel}>Unit:</Text>
              <View style={styles.oneTimeUnitGrid}>
                {['Unit', 'Box', 'Bundle', 'Reel', 'Length (ft)', 'Length (in)', 'Bottle'].map((unitOption) => (
                  <TouchableOpacity
                    key={unitOption}
                    style={[styles.oneTimeUnitButton, oneTimeUnit === unitOption && styles.oneTimeUnitButtonActive]}
                    onPress={() => setOneTimeUnit(unitOption)}
                  >
                    <Text style={[styles.oneTimeUnitText, oneTimeUnit === unitOption && styles.oneTimeUnitTextActive]}>{unitOption}</Text>
                  </TouchableOpacity>
                ))}
              </View>

              <Text style={styles.modalLabel}>Note / Destination:</Text>
              <TextInput
                style={styles.modalInput}
                value={oneTimeNote}
                onChangeText={setOneTimeNote}
                placeholder="Optional note"
                placeholderTextColor="#777"
              />

              <View style={styles.modalActions}>
                <TouchableOpacity style={[styles.modalButton, { backgroundColor: '#8892b0' }]} onPress={() => setOneTimeModalVisible(false)}>
                  <Text style={styles.btnText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.modalButton, { backgroundColor: '#0275d8' }]} onPress={addOneTimeMaterialToList}>
                  <Text style={styles.btnText}>Add</Text>
                </TouchableOpacity>
              </View>
            </View>
          </SafeAreaView>
        </View>
      </Modal>

      {/* Edit Material Modal */}
      <Modal visible={editModalVisible} transparent animationType="fade" onRequestClose={() => setEditModalVisible(false)}>
        <View style={styles.modalOverlay}>
          <SafeAreaView style={styles.modalSafeArea}>
            <View style={styles.modalContent}>
              <TouchableOpacity style={styles.menuCloseIconButton} onPress={() => setEditModalVisible(false)}>
                <Text style={styles.menuCloseIconText}>✕</Text>
              </TouchableOpacity>
              <Text style={styles.modalTitle}>EDIT MATERIAL</Text>
              <Text style={styles.modalHelpText}>Update quantity, unit or notes for this item.</Text>

              <Text style={styles.modalLabel}>Material:</Text>
              <Text style={styles.modalMaterialNameDisplay}>
                {editingIndex !== null ? items[editingIndex]?.material?.name : ''}
              </Text>

              <Text style={styles.modalLabel}>Quantity:</Text>
              <View style={styles.quantityStepper}>
                <TouchableOpacity style={styles.quantityButton} onPress={decrementEditQuantity}>
                  <Text style={styles.quantityButtonText}>−</Text>
                </TouchableOpacity>
                <TextInput
                  style={[styles.modalInput, styles.quantityInput]}
                  keyboardType="numeric"
                  value={editQuantity}
                  onChangeText={setEditQuantity}
                  textAlign="center"
                />
                <TouchableOpacity style={styles.quantityButton} onPress={incrementEditQuantity}>
                  <Text style={styles.quantityButtonText}>+</Text>
                </TouchableOpacity>
              </View>

              <Text style={styles.modalLabel}>Unit:</Text>
              <View style={styles.oneTimeUnitGrid}>
                {['Unit', 'Box', 'Bundle', 'Reel', 'Length (ft)', 'Length (in)', 'Bottle'].map((unitOption) => (
                  <TouchableOpacity
                    key={unitOption}
                    style={[styles.oneTimeUnitButton, editUnit === unitOption && styles.oneTimeUnitButtonActive]}
                    onPress={() => setEditUnit(unitOption)}
                  >
                    <Text style={[styles.oneTimeUnitText, editUnit === unitOption && styles.oneTimeUnitTextActive]}>{unitOption}</Text>
                  </TouchableOpacity>
                ))}
              </View>

              {(editUnit === 'Length (ft)' || editUnit === 'Reel') && (
                <>
                  <Text style={styles.modalLabel}>Length / Distribution Detail:</Text>
                  <TextInput
                    style={styles.modalInput}
                    value={editLengthDetail}
                    onChangeText={setEditLengthDetail}
                    placeholder="e.g.: 50ft / Room A"
                    placeholderTextColor="#777"
                  />
                </>
              )}

              <Text style={styles.modalLabel}>Note / Destination:</Text>
              <TextInput
                style={styles.modalInput}
                value={editNote}
                onChangeText={setEditNote}
                placeholder="Optional note"
                placeholderTextColor="#777"
              />

              <View style={styles.modalActions}>
                <TouchableOpacity style={[styles.modalButton, { backgroundColor: '#8892b0' }]} onPress={() => setEditModalVisible(false)}>
                  <Text style={styles.btnText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.modalButton, { backgroundColor: '#0275d8' }]} onPress={saveEdit}>
                  <Text style={styles.btnText}>Save Changes</Text>
                </TouchableOpacity>
              </View>
            </View>
          </SafeAreaView>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a192f' },
  customHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 15,
    height: 60,
    backgroundColor: '#112240',
    borderBottomWidth: 1,
    borderBottomColor: '#233554',
  },
  headerLeftSpacer: {
    width: 40
  },
  customHeaderTitle: {
    color: '#64ffda',
    fontSize: 18,
    fontWeight: 'bold',
    flex: 1,
    textAlign: 'center'
  },
  headerMenuButton: {
    width: 40,
    alignItems: 'flex-end',
    justifyContent: 'center'
  },
  headerMenuText: {
    color: '#64ffda',
    fontSize: 24
  },
  content: { padding: 12 },
  section: { marginBottom: 10 },
  label: { color: '#64ffda', fontWeight: 'bold', marginBottom: 5, fontSize: 13, textTransform: 'uppercase', letterSpacing: 0.5 },
  input: { backgroundColor: '#172a45', padding: 11, borderRadius: 8, marginBottom: 8, color: '#e6f1ff', borderWidth: 1, borderColor: '#303c55', fontSize: 14 },
  helperText: { color: '#8892b0', fontSize: 11, marginBottom: 12, marginTop: -2 },

  // Spreadsheet-style horizontal table styles.
  tableCard: { backgroundColor: '#fff', borderRadius: 12, padding: 12, marginTop: 5, elevation: 6, shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 4, shadowOffset: { width: 0, height: 2 } },
  tableTitle: { fontSize: 15, fontWeight: '900', marginBottom: 12, textAlign: 'center', color: '#0275d8', letterSpacing: 0.5 },
  tableHeader: { flexDirection: 'row', borderBottomWidth: 2, borderColor: '#ccc', paddingBottom: 6, marginBottom: 4 },
  headerCell: { fontSize: 11, fontWeight: '800', color: '#666', textTransform: 'uppercase' },
  row: { flexDirection: 'row', borderBottomWidth: 1, borderColor: '#eef2f5', paddingVertical: 10, alignItems: 'center' },
  cellText: { fontSize: 13, color: '#333' },
  cellMaterialName: { fontSize: 13, fontWeight: '700', color: '#111' },
  cellLengthDetail: { fontSize: 12, color: '#0275d8', fontWeight: '800', marginTop: 2 },
  emptyText: { textAlign: 'center', padding: 35, color: '#999', fontStyle: 'italic', fontSize: 13 },

  // Action buttons and table controls.
  actionCell: { width: 70, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  btnEditRow: { width: 30, height: 30, justifyContent: 'center', alignItems: 'center', backgroundColor: '#e3f2fd', borderRadius: 6 },
  btnEditRowText: { color: '#0275d8', fontWeight: 'bold', fontSize: 18 },
  btnDeleteRow: { width: 30, height: 30, justifyContent: 'center', alignItems: 'center', backgroundColor: '#fcebe9', borderRadius: 6 },
  btnDeleteRowText: { color: '#e74c3c', fontWeight: 'bold', fontSize: 14 },
  btnPrimary: { backgroundColor: '#007bff', padding: 15, borderRadius: 10, alignItems: 'center', marginTop: 20, borderWidth: 1, borderColor: '#00d2ff' },
  menuButton: { backgroundColor: '#172a45', padding: 15, borderRadius: 10, alignItems: 'center', marginTop: 12, borderWidth: 1, borderColor: '#64ffda' },
  menuOverlay: { flex: 1, backgroundColor: 'rgba(2, 12, 27, 0.8)', justifyContent: 'center', alignItems: 'center', padding: 22 },
  menuContent: { width: '100%', backgroundColor: '#ccd6f6', borderRadius: 18, padding: 20, paddingTop: 42, position: 'relative' },
  menuCloseIconButton: { position: 'absolute', top: 10, right: 10, width: 34, height: 34, borderRadius: 17, backgroundColor: '#0a192f', alignItems: 'center', justifyContent: 'center', zIndex: 10 },
  menuCloseIconText: { color: '#fff', fontWeight: '900', fontSize: 16 },
  menuTitle: { color: '#0a192f', fontSize: 20, fontWeight: '900', textAlign: 'center' },
  menuSubtitle: { color: '#475569', textAlign: 'center', marginTop: 4, marginBottom: 16 },
  menuOption: { backgroundColor: '#fff', borderRadius: 14, padding: 15, marginBottom: 10, borderWidth: 1, borderColor: '#cbd5e1' },
  menuOptionText: { color: '#0a192f', fontWeight: '900', fontSize: 15 },
  menuCloseButton: { backgroundColor: '#0a192f', padding: 13, borderRadius: 12, alignItems: 'center', marginTop: 4 },
  menuCloseText: { color: '#fff', fontWeight: '900' },
  btnSecondary: { backgroundColor: '#112240', padding: 15, borderRadius: 10, alignItems: 'center', marginTop: 12, borderWidth: 1, borderColor: '#64ffda' },
  btnPdf: { backgroundColor: '#b45309', padding: 15, borderRadius: 8, alignItems: 'center', marginTop: 10 },
  btnShare: { backgroundColor: '#25D366', padding: 15, borderRadius: 10, alignItems: 'center', marginTop: 12 },
  btnDanger: { backgroundColor: '#ff4d4d15', padding: 14, borderRadius: 10, alignItems: 'center', marginTop: 12, borderWidth: 1, borderColor: '#ff4d4d' },
  btnText: { color: '#fff', fontWeight: 'bold', fontSize: 14, textTransform: 'uppercase', letterSpacing: 0.5 },

  // One-time material modal styles.
  modalOverlay: { flex: 1, backgroundColor: 'rgba(2, 12, 27, 0.82)', justifyContent: 'center', alignItems: 'center' },
  modalSafeArea: { width: '100%', paddingHorizontal: 14, justifyContent: 'center', alignItems: 'center' },
  modalContent: { backgroundColor: '#ccd6f6', width: '100%', padding: 20, borderRadius: 15, position: 'relative' },
  modalTitle: { fontSize: 15, fontWeight: '900', color: '#0a192f', textAlign: 'center', marginBottom: 8 },
  modalMaterialNameDisplay: { fontSize: 14, fontWeight: 'bold', color: '#007bff', marginBottom: 10, backgroundColor: '#fff', padding: 8, borderRadius: 5, borderWidth: 1, borderColor: '#dbe3ef' },
  modalHelpText: { color: '#334', fontSize: 12, textAlign: 'center', marginBottom: 12 },
  modalLabel: { fontWeight: 'bold', color: '#0a192f', marginTop: 10, fontSize: 12, textTransform: 'uppercase' },
  modalInput: { borderBottomWidth: 1.5, borderColor: '#0a192f55', padding: 7, marginBottom: 8, color: '#0a192f', fontSize: 14 },
  quantityStepper: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#fff', borderRadius: 8, borderWidth: 1, borderColor: '#dbe3ef', overflow: 'hidden', marginBottom: 8, marginTop: 5 },
  quantityButton: { width: 50, height: 45, backgroundColor: '#f0f4f8', justifyContent: 'center', alignItems: 'center' },
  quantityButtonText: { fontSize: 24, color: '#0275d8', fontWeight: 'bold' },
  quantityInput: { flex: 1, borderBottomWidth: 0, marginBottom: 0, fontSize: 18, fontWeight: 'bold', textAlign: 'center' },
  oneTimeUnitGrid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', marginTop: 8 },
  oneTimeUnitButton: { backgroundColor: '#fff', padding: 8, borderRadius: 6, marginBottom: 6, width: '31%', alignItems: 'center', borderWidth: 1, borderColor: '#ccc' },
  oneTimeUnitButtonActive: { backgroundColor: '#0275d8', borderColor: '#0275d8' },
  oneTimeUnitText: { fontSize: 11, color: '#333', fontWeight: 'bold' },
  oneTimeUnitTextActive: { color: '#fff' },
  modalActions: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 15 },
  modalButton: { padding: 12, borderRadius: 8, width: '48%', alignItems: 'center' },

  // Material Requirements image preview and generated document.
  quantityPreviewOverlay: { flex: 1, backgroundColor: 'rgba(2, 12, 27, 0.9)' },
  quantityPreviewSafeArea: { flex: 1, paddingHorizontal: 10, paddingVertical: 8 },
  quantityPreviewCard: { flex: 1, backgroundColor: '#dbe7ff', borderRadius: 18, overflow: 'hidden' },
  quantityPreviewTopBar: { minHeight: 58, backgroundColor: '#112240', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 10 },
  quantityPreviewTitle: { color: '#fff', fontSize: 18, fontWeight: '900', textAlign: 'center', flex: 1 },
  quantityPreviewClose: { width: 42, height: 42, borderRadius: 21, backgroundColor: '#0a192f', alignItems: 'center', justifyContent: 'center' },
  quantityPreviewCloseText: { color: '#fff', fontSize: 20, fontWeight: '900' },
  quantityPreviewScroll: { flex: 1 },
  quantityPreviewScrollContent: { padding: 10, alignItems: 'center' },
  quantityCaptureWrapper: { width: '100%', maxWidth: 760 },
  quantityDocument: { width: '100%', backgroundColor: '#f8fafc', borderRadius: 12, overflow: 'hidden', paddingBottom: 24 },
  quantityDocumentHero: { minHeight: 112, backgroundColor: '#052a4a', paddingHorizontal: 20, paddingVertical: 16, flexDirection: 'row', alignItems: 'center' },
  quantityDocumentHeroTextWrap: { flex: 1, paddingRight: 8, justifyContent: 'center' },
  quantityDocumentHeroTitle: { color: '#fff', fontSize: 27, lineHeight: 31, fontWeight: '900', letterSpacing: 0.5 },
  quantityDocumentUnderline: { width: 92, height: 4, backgroundColor: '#0ea5e9', marginTop: 9 },
  quantityDocumentIconWrap: { width: 82, alignItems: 'center', justifyContent: 'center' },
  quantityDocumentIcon: { fontSize: 40 },
  quantityDocumentIconLabel: { color: '#38bdf8', fontSize: 10, fontWeight: '900' },
  quantityDocumentMeta: { paddingHorizontal: 20, paddingVertical: 16 },
  quantityDocumentMetaLabel: { color: '#092f55', fontWeight: '900', marginTop: 7, fontSize: 12 },
  quantityDocumentMetaValue: { color: '#111827', minHeight: 27, borderBottomWidth: 1, borderBottomColor: '#94a3b8', paddingVertical: 4, marginBottom: 4, fontSize: 14 },
  quantityDocumentTable: { marginHorizontal: 14, marginTop: 8, borderWidth: 1, borderColor: '#94a3b8', borderRadius: 8, overflow: 'hidden' },
  quantityDocumentSectionTitle: { backgroundColor: '#052a4a', paddingVertical: 10, paddingHorizontal: 8 },
  quantityDocumentSectionTitleText: { color: '#fff', fontSize: 18, fontWeight: '900', textAlign: 'center' },
  quantityDocumentTableHeader: { flexDirection: 'row', backgroundColor: '#07345d' },
  quantityDocumentTableRow: { flexDirection: 'row', minHeight: 52, backgroundColor: '#fff' },
  quantityDocHeaderCell: { color: '#fff', fontWeight: '900', textAlign: 'center', paddingHorizontal: 5, paddingVertical: 10, borderRightWidth: 1, borderBottomWidth: 1, borderColor: '#94a3b8', fontSize: 10 },
  quantityDocBodyCell: { color: '#111827', textAlign: 'center', paddingHorizontal: 5, paddingVertical: 11, borderRightWidth: 1, borderBottomWidth: 2, borderColor: '#94a3b8', fontSize: 12, textAlignVertical: 'center' },
  quantityDocDescriptionBody: { paddingHorizontal: 8, paddingVertical: 8, borderRightWidth: 1, borderBottomWidth: 2, borderColor: '#94a3b8', justifyContent: 'center' },
  quantityDocMaterialName: { color: '#111827', fontWeight: '800', fontSize: 12 },
  quantityDocMaterialDetail: { color: '#475569', fontSize: 10, marginTop: 2 },
  quantityDocNumberColumn: { width: '15%' },
  quantityDocDescriptionColumn: { width: '49%' },
  quantityDocQtyColumn: { width: '14%' },
  quantityDocUnitColumn: { width: '22%' },
  quantityDocItemNumber: { color: '#0b4a83', fontWeight: '900' },
  quantityPreviewActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, padding: 12, backgroundColor: '#ccd6f6', borderTopWidth: 1, borderTopColor: '#94a3b8' },
  quantityPreviewCancelButton: { flex: 1, minHeight: 48, borderRadius: 10, borderWidth: 1, borderColor: '#475569', alignItems: 'center', justifyContent: 'center', backgroundColor: '#fff' },
  quantityPreviewCancelText: { color: '#0a192f', fontWeight: '900' },
  quantityPreviewShareButton: { flex: 1.3, minWidth: 110, minHeight: 48, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: '#12a86b' },
  quantityPreviewPdfButton: { flex: 1.3, minWidth: 110, minHeight: 48, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: '#b45309' },
  quantityPreviewShareText: { color: '#fff', fontWeight: '900' },
  quantityPreviewButtonDisabled: { opacity: 0.55 },

});
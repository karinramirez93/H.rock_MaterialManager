import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  BackHandler,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import ViewShot from 'react-native-view-shot';
import * as Sharing from 'expo-sharing';
import * as Print from 'expo-print';
import * as FileSystem from 'expo-file-system/legacy';
import { StorageService } from '../database/storage';

const TYPE_LABELS = { cable: 'Cable', wire: 'Wire' };

const emptyEditor = () => ({ id: '', type: 'cable', name: '', length: '', saveToCatalog: false });

const CABLE_CATALOG_PAGE_SIZE = 10;

const normalizeCableWireName = (value) => {
  let text = String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ');

  if (!text) return '';

  // Normalize common field shorthand:
  // 4c#12, 4 C#12, and 4c # 12 all become "4C # 12".
  text = text
    .replace(/(\d+)\s*C(?=\s|#|-|\d|$)/g, '$1C')
    .replace(/\s*#\s*/g, ' # ')
    .replace(/\s*-\s*/g, ' - ')
    .replace(/\bKCMIL\b/g, 'KCMIL')
    .replace(/\bKMIL\b/g, 'KMIL')
    .replace(/\s+/g, ' ')
    .trim();

  // Keep a leading wire gauge readable: #4/0 -> # 4/0.
  text = text.replace(/^#\s*/, '# ');

  return text;
};

const getCableCatalogSearchKey = (value) => normalizeCableWireName(value)
  .replace(/\s+/g, '')
  .toLowerCase();


export default function CableRequirementsScreen({ currentUser }) {
  const insets = useSafeAreaInsets();
  const sheetRef = useRef(null);
  const [projectName, setProjectName] = useState('');
  const [requestedBy, setRequestedBy] = useState('');
  const [items, setItems] = useState([]);
  const [catalog, setCatalog] = useState([]);
  const [editorVisible, setEditorVisible] = useState(false);
  const [editor, setEditor] = useState(emptyEditor());
  const [saving, setSaving] = useState(false);
  const [generatingPdf, setGeneratingPdf] = useState(false);
  const [catalogManagerVisible, setCatalogManagerVisible] = useState(false);
  const [catalogManagerPage, setCatalogManagerPage] = useState(1);
  const [catalogManagerSearch, setCatalogManagerSearch] = useState('');
  const [catalogEntryEditorVisible, setCatalogEntryEditorVisible] = useState(false);
  const [catalogEntryEditor, setCatalogEntryEditor] = useState({ id: '', type: 'cable', name: '' });
  const [catalogMaintenanceBusy, setCatalogMaintenanceBusy] = useState(false);


  useEffect(() => {
    setRequestedBy(
      currentUser?.username || currentUser?.displayName || currentUser?.email?.split('@')[0] || ''
    );
    loadInitialData();
  }, [currentUser?.uid]);

  useEffect(() => {
    const handler = BackHandler.addEventListener('hardwareBackPress', () => {
      if (catalogEntryEditorVisible) {
        setCatalogEntryEditorVisible(false);
        return true;
      }
      if (catalogManagerVisible) {
        setCatalogManagerVisible(false);
        return true;
      }
      if (editorVisible) {
        setEditorVisible(false);
        return true;
      }
      return false;
    });
    return () => handler.remove();
  }, [editorVisible, catalogManagerVisible, catalogEntryEditorVisible]);

  const loadInitialData = async () => {
    try {
      const [savedDraft, savedCatalog] = await Promise.all([
        StorageService.loadCableRequirementDraft(),
        StorageService.syncCableCatalog(),
      ]);
      setProjectName(savedDraft?.projectName || '');
      setItems(Array.isArray(savedDraft?.items) ? savedDraft.items : []);
      setCatalog(Array.isArray(savedCatalog) ? savedCatalog : []);
      if (savedDraft?.requestedBy) setRequestedBy(savedDraft.requestedBy);
    } catch (error) {
      console.warn('Cable requirements load warning:', error);
      const localCatalog = await StorageService.loadCableCatalogCache();
      setCatalog(localCatalog || []);
    }
  };

  const persistDraft = async (nextItems = items, nextProjectName = projectName, nextRequestedBy = requestedBy) => {
    await StorageService.saveCableRequirementDraft({
      projectName: nextProjectName,
      requestedBy: nextRequestedBy,
      items: nextItems,
      updatedAt: new Date().toISOString(),
    });
  };

  const cableItems = useMemo(() => items.filter((item) => item.type === 'cable'), [items]);
  const wireItems = useMemo(() => items.filter((item) => item.type === 'wire'), [items]);

  const openNewEditor = (type = 'cable') => {
    setEditor({ ...emptyEditor(), type });
    setEditorVisible(true);
  };

  const openEditEditor = (item) => {
    setEditor({ ...item, saveToCatalog: false });
    setEditorVisible(true);
  };

  const applyCatalogSuggestion = (entry) => {
    setEditor((current) => ({
      ...current,
      type: entry.type,
      name: normalizeCableWireName(entry.name),
    }));
  };

  const saveEditor = async () => {
    const cleanName = normalizeCableWireName(editor.name);
    const cleanLength = editor.length.trim();
    if (!cleanName || !cleanLength) {
      Alert.alert('Missing information', 'Enter the cable or wire name and its length.');
      return;
    }

    setSaving(true);
    try {
      const nextItem = {
        id: editor.id || `cable-row-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        type: editor.type,
        name: cleanName,
        length: cleanLength,
        updatedAt: new Date().toISOString(),
      };
      const nextItems = editor.id
        ? items.map((item) => (item.id === editor.id ? nextItem : item))
        : [...items, nextItem];

      setItems(nextItems);
      // Requirement rows and lengths are working data and stay on this device.
      // This save updates AsyncStorage/SQLite only; it does not contact Firebase.
      await persistDraft(nextItems);

      const catalogMatch = catalog.some((entry) =>
        entry.type === editor.type
        && getCableCatalogSearchKey(entry.name) === getCableCatalogSearchKey(cleanName)
      );

      const uploadNewCatalogName = async () => {
        try {
          const nextCatalog = await StorageService.saveCableCatalogEntry({ type: editor.type, name: cleanName });
          setCatalog(nextCatalog);
        } catch (catalogError) {
          Alert.alert(
            'Saved locally',
            `The requirement was saved on this device, but the reusable name could not be added to Firebase: ${catalogError?.message || 'Unknown error'}`
          );
        }
      };

      setEditorVisible(false);

      // Existing names are already available locally and centrally, so no
      // Firebase write is needed. New names are uploaded only with consent.
      if (!editor.id && !catalogMatch) {
        if (editor.saveToCatalog) {
          await uploadNewCatalogName();
        } else {
          Alert.alert(
            'New cable/wire name',
            `“${cleanName}” is not in the reusable catalog. Add only this name to Firebase so other devices can use it later?`,
            [
              { text: 'Keep Local Only', style: 'cancel' },
              { text: 'Add to Cloud', onPress: uploadNewCatalogName },
            ]
          );
        }
      }
    } catch (error) {
      Alert.alert('Unable to save', error?.message || 'The item could not be saved.');
    } finally {
      setSaving(false);
    }
  };


  const openCableCatalogManager = () => {
    setCatalogManagerSearch('');
    setCatalogManagerPage(1);
    setCatalogManagerVisible(true);
  };

  const openCableCatalogEntryEditor = (entry) => {
    setCatalogEntryEditor({
      id: entry.id,
      type: entry.type === 'wire' ? 'wire' : 'cable',
      name: normalizeCableWireName(entry.name),
    });
    setCatalogEntryEditorVisible(true);
  };

  const saveCableCatalogMaintenanceEntry = async () => {
    const normalizedName = normalizeCableWireName(catalogEntryEditor.name);
    if (!normalizedName) {
      Alert.alert('Name required', 'Enter a cable or wire name.');
      return;
    }

    setCatalogMaintenanceBusy(true);
    try {
      const nextCatalog = await StorageService.saveCableCatalogEntry({
        id: catalogEntryEditor.id,
        type: catalogEntryEditor.type,
        name: normalizedName,
      });
      setCatalog(nextCatalog);
      setCatalogEntryEditorVisible(false);
      Alert.alert('Catalog updated', `${normalizedName} was saved.`);
    } catch (error) {
      Alert.alert('Unable to update catalog', error?.message || 'The entry could not be updated.');
    } finally {
      setCatalogMaintenanceBusy(false);
    }
  };

  const deleteCableCatalogMaintenanceEntry = (entry) => {
    Alert.alert(
      'Delete reusable name?',
      `Delete “${entry.name}” from Firebase and from the local suggestion catalog? Existing requirement rows will not be changed.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            setCatalogMaintenanceBusy(true);
            try {
              const nextCatalog = await StorageService.deleteCableCatalogEntry(entry.id);
              setCatalog(nextCatalog);
              const remainingPages = Math.max(1, Math.ceil(nextCatalog.length / CABLE_CATALOG_PAGE_SIZE));
              setCatalogManagerPage((page) => Math.min(page, remainingPages));
            } catch (error) {
              Alert.alert('Unable to delete catalog entry', error?.message || 'The entry could not be deleted.');
            } finally {
              setCatalogMaintenanceBusy(false);
            }
          },
        },
      ]
    );
  };

  const removeItem = (itemId) => {
    Alert.alert('Delete item?', 'This removes the row from the current requirement sheet.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          const nextItems = items.filter((item) => item.id !== itemId);
          setItems(nextItems);
          await persistDraft(nextItems);
        },
      },
    ]);
  };

  const clearSheet = () => {
    Alert.alert('Clear requirement sheet?', 'All current cable and wire rows will be removed.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Clear',
        style: 'destructive',
        onPress: async () => {
          setItems([]);
          await persistDraft([]);
        },
      },
    ]);
  };

  const escapeHtml = (value) => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');

  const createRequirementSectionHtml = (type, sectionItems) => {
    if (!sectionItems.length) return '';
    const rows = sectionItems.map((item, index) => `
      <tr>
        <td class="number">${index + 1}</td>
        <td>${escapeHtml(item.name)}</td>
        <td class="length">${escapeHtml(item.length)}</td>
      </tr>
    `).join('');
    return `
      <section class="section">
        <div class="section-title">${TYPE_LABELS[type].toUpperCase()} REQUIREMENTS</div>
        <table>
          <thead><tr><th class="number">ITEM NO.</th><th>ITEM DESCRIPTION</th><th class="length">LENGTH (FT/IN)</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </section>
    `;
  };

  const buildCableRequirementsPdfHtml = () => `
    <!DOCTYPE html>
    <html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
      @page { size: Letter; margin: 24px; }
      * { box-sizing: border-box; }
      body { margin: 0; font-family: Arial, Helvetica, sans-serif; color: #111827; background: #fff; }
      .document { border: 1px solid #94a3b8; border-radius: 10px; overflow: hidden; }
      .hero { min-height: 112px; background: #052a4a; color: white; padding: 20px 24px; display: flex; align-items: center; justify-content: space-between; }
      .hero h1 { margin: 0; max-width: 78%; font-size: ${cableItems.length && wireItems.length ? '25px' : '30px'}; line-height: 1.05; font-weight: 900; letter-spacing: .4px; }
      .underline { width: 92px; height: 4px; margin-top: 10px; background: #0ea5e9; }
      .icon { width: 90px; text-align: center; color: #38bdf8; font-weight: 900; font-size: 11px; }
      .icon .bolt { font-size: 42px; display: block; }
      .meta { padding: 18px 24px 8px; }
      .meta-label { color: #092f55; font-size: 12px; font-weight: 900; margin-top: 8px; }
      .meta-value { min-height: 28px; padding: 5px 2px; border-bottom: 1px solid #94a3b8; font-size: 14px; }
      .section { margin: 16px 18px 20px; border: 1px solid #94a3b8; border-radius: 8px; overflow: hidden; page-break-inside: auto; }
      .section-title { background: #052a4a; color: #fff; text-align: center; font-size: 18px; font-weight: 900; padding: 10px; }
      table { width: 100%; border-collapse: collapse; table-layout: fixed; }
      th { background: #07345d; color: #fff; font-size: 11px; font-weight: 900; padding: 10px 7px; border-right: 1px solid #94a3b8; border-bottom: 2px solid #94a3b8; }
      td { min-height: 42px; padding: 11px 8px; font-size: 13px; text-align: center; border-right: 1px solid #94a3b8; border-bottom: 2px solid #94a3b8; overflow-wrap: anywhere; }
      tr:last-child td { border-bottom: 0; }
      th:last-child, td:last-child { border-right: 0; }
      .number { width: 18%; color: inherit; font-weight: 900; }
      td.number { color: #0b4a83; }
      .length { width: 30%; }
    </style></head>
    <body><div class="document">
      <div class="hero"><div><h1>${escapeHtml(documentTitle)}</h1><div class="underline"></div></div><div class="icon"><span class="bolt">⚡</span>CABLES</div></div>
      <div class="meta"><div class="meta-label">▣ PROJECT / JOB NAME:</div><div class="meta-value">${escapeHtml(projectName || ' ')}</div><div class="meta-label">● REQUESTED BY:</div><div class="meta-value">${escapeHtml(requestedBy || ' ')}</div></div>
      ${createRequirementSectionHtml('cable', cableItems)}
      ${createRequirementSectionHtml('wire', wireItems)}
    </div></body></html>`;

  const shareGeneratedPdf = async () => {
    if (!items.length) {
      Alert.alert('Nothing to share', 'Add at least one cable or wire first.');
      return;
    }
    setGeneratingPdf(true);
    try {
      await persistDraft();
      const { base64: pdfBase64 } = await Print.printToFileAsync({
        html: buildCableRequirementsPdfHtml(),
        base64: true,
      });

      // Expo Go can return a temporary Print URI that FileSystem and Sharing
      // cannot read. The returned base64 lets us create a fresh PDF inside the
      // app cache without trying to copy that inaccessible temporary file.
      if (!pdfBase64) {
        throw new Error('CABLE_REQUIREMENTS_PDF_BASE64_MISSING');
      }

      const shareableUri = `${FileSystem.cacheDirectory}cable-wire-requirements-${Date.now()}.pdf`;
      await FileSystem.writeAsStringAsync(shareableUri, pdfBase64, {
        encoding: FileSystem.EncodingType.Base64,
      });

      const pdfInfo = await FileSystem.getInfoAsync(shareableUri, { size: true });
      if (!pdfInfo.exists || !pdfInfo.size) {
        throw new Error('CABLE_REQUIREMENTS_PDF_CACHE_WRITE_FAILED');
      }

      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(shareableUri, {
          mimeType: 'application/pdf',
          dialogTitle: 'Share cable requirements PDF',
          UTI: 'com.adobe.pdf',
        });
      } else {
        Alert.alert('PDF created', `The PDF was created at: ${shareableUri}`);
      }
    } catch (error) {
      console.error('Unable to generate cable requirements PDF:', error);
      Alert.alert('Unable to generate PDF', 'Confirm that expo-print and expo-sharing are installed, then rebuild or restart the app.');
    } finally {
      setGeneratingPdf(false);
    }
  };

  const shareGeneratedImage = async () => {
    if (!items.length) {
      Alert.alert('Nothing to share', 'Add at least one cable or wire first.');
      return;
    }
    try {
      await persistDraft();
      const uri = await sheetRef.current?.capture?.();
      if (!uri) throw new Error('IMAGE_CAPTURE_FAILED');
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(uri, { mimeType: 'image/png', dialogTitle: 'Share cable requirements' });
      } else {
        await Share.share({ message: `Cable/Wire Requirements\nProject: ${projectName}\nRequested by: ${requestedBy}` });
      }
    } catch (error) {
      Alert.alert('Unable to generate image', 'Install react-native-view-shot and expo-sharing, then rebuild the app.');
    }
  };

  const renderRequirementSection = (type, sectionItems) => {
    if (!sectionItems.length) return null;
    const title = `${TYPE_LABELS[type].toUpperCase()} REQUIREMENTS`;
    return (
      <View style={styles.sheetSection}>
        <View style={styles.sectionTitleBar}><Text style={styles.sectionTitleText}>{title}</Text></View>
        <View style={styles.tableHeader}>
          <Text style={[styles.headerCell, styles.numberColumn]}>ITEM NO.</Text>
          <Text style={[styles.headerCell, styles.descriptionColumn]}>ITEM DESCRIPTION</Text>
          <Text style={[styles.headerCell, styles.lengthColumn]}>LENGTH (FT/IN)</Text>
        </View>
        {sectionItems.map((item, index) => (
          <View key={item.id} style={styles.tableRow}>
            <Text style={[styles.bodyCell, styles.numberColumn, styles.itemNumber]}>{index + 1}</Text>
            <Text style={[styles.bodyCell, styles.descriptionColumn]}>{item.name}</Text>
            <Text style={[styles.bodyCell, styles.lengthColumn]}>{item.length}</Text>
          </View>
        ))}
      </View>
    );
  };

  const documentTitle = cableItems.length && wireItems.length
    ? 'CABLE AND WIRE REQUIREMENTS'
    : cableItems.length
      ? 'CABLE REQUIREMENTS'
      : 'WIRE REQUIREMENTS';

  const documentTitleStyle = cableItems.length && wireItems.length
    ? styles.heroTitleLong
    : styles.heroTitleShort;

  const normalizedEditorName = normalizeCableWireName(editor.name);
  const editorSearchKey = getCableCatalogSearchKey(editor.name);

  const matchingSuggestions = catalog
    .filter((entry) => entry.type === editor.type)
    .filter((entry) => !editorSearchKey || getCableCatalogSearchKey(entry.name).includes(editorSearchKey))
    .slice(0, 8);

  const showNormalizedNameSuggestion = Boolean(
    editor.name.trim()
    && normalizedEditorName
    && normalizedEditorName !== editor.name.trim()
  );

  const filteredManagedCatalog = catalog
    .filter((entry) => {
      const searchKey = getCableCatalogSearchKey(catalogManagerSearch);
      return !searchKey
        || getCableCatalogSearchKey(entry.name).includes(searchKey)
        || String(entry.type || '').toLowerCase().includes(catalogManagerSearch.trim().toLowerCase());
    })
    .sort((a, b) => {
      const typeOrder = String(a.type).localeCompare(String(b.type));
      return typeOrder || String(a.name).localeCompare(String(b.name));
    });

  const catalogManagerPageCount = Math.max(1, Math.ceil(filteredManagedCatalog.length / CABLE_CATALOG_PAGE_SIZE));
  const visibleManagedCatalog = filteredManagedCatalog.slice(
    (catalogManagerPage - 1) * CABLE_CATALOG_PAGE_SIZE,
    catalogManagerPage * CABLE_CATALOG_PAGE_SIZE
  );

  return (
    <SafeAreaView style={styles.screen} edges={['bottom']}>
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: Math.max(insets.bottom, 16) + 30 }]} keyboardShouldPersistTaps="handled">
        <Text style={styles.pageTitle}>Cable & Wire Requirements</Text>
        <Text style={styles.pageSubtitle}>Work locally and generate a shareable image or PDF. Firebase is checked only for reusable catalog changes.</Text>

        <Text style={styles.label}>Project / Job Name</Text>
        <TextInput
          style={styles.input}
          value={projectName}
          onChangeText={(value) => { setProjectName(value); persistDraft(items, value, requestedBy); }}
          placeholder="Project or job name"
          placeholderTextColor="#64748b"
        />
        <Text style={styles.label}>Requested By</Text>
        <TextInput
          style={styles.input}
          value={requestedBy}
          onChangeText={(value) => { setRequestedBy(value); persistDraft(items, projectName, value); }}
          placeholder="Employee name"
          placeholderTextColor="#64748b"
        />

        <View style={styles.actionRow}>
          <TouchableOpacity style={styles.addButton} onPress={() => openNewEditor('cable')}><Text style={styles.addButtonText}>+ Cable</Text></TouchableOpacity>
          <TouchableOpacity style={styles.addButton} onPress={() => openNewEditor('wire')}><Text style={styles.addButtonText}>+ Wire</Text></TouchableOpacity>
        </View>
        {currentUser?.role === 'owner' && (
          <TouchableOpacity style={styles.manageCatalogButton} onPress={openCableCatalogManager}>
            <Text style={styles.manageCatalogButtonText}>⚙ MANAGE CABLE / WIRE CATALOG</Text>
          </TouchableOpacity>
        )}

        {items.map((item) => (
          <View key={item.id} style={styles.editorListRow}>
            <View style={styles.typePill}><Text style={styles.typePillText}>{TYPE_LABELS[item.type]}</Text></View>
            <View style={{ flex: 1 }}><Text style={styles.rowName}>{item.name}</Text><Text style={styles.rowLength}>{item.length}</Text></View>
            <TouchableOpacity onPress={() => openEditEditor(item)} style={styles.smallButton}><Text>✎</Text></TouchableOpacity>
            <TouchableOpacity onPress={() => removeItem(item.id)} style={styles.smallButton}><Text>✕</Text></TouchableOpacity>
          </View>
        ))}

        {!!items.length && (
          <>
            <TouchableOpacity style={styles.shareButton} onPress={shareGeneratedImage}><Text style={styles.shareButtonText}>Generate & Share Image</Text></TouchableOpacity>
            <TouchableOpacity style={[styles.pdfButton, generatingPdf && styles.disabledButton]} onPress={shareGeneratedPdf} disabled={generatingPdf}><Text style={styles.shareButtonText}>{generatingPdf ? 'Generating PDF...' : 'Generate & Share PDF'}</Text></TouchableOpacity>
            <TouchableOpacity style={styles.clearButton} onPress={clearSheet}><Text style={styles.clearButtonText}>Clear Current Sheet</Text></TouchableOpacity>
          </>
        )}

        <ViewShot ref={sheetRef} options={{ format: 'png', quality: 1 }} style={styles.captureWrapper}>
          <View style={styles.requirementSheet}>
            <View style={styles.heroHeader}>
              <View style={styles.heroTitleContainer}>
                <Text
                  style={[styles.heroTitle, documentTitleStyle]}
                  numberOfLines={2}
                  adjustsFontSizeToFit
                  minimumFontScale={0.72}
                >
                  {documentTitle}
                </Text>
                <View style={styles.blueUnderline} />
              </View>
              <View style={styles.cableArt}><Text style={styles.cableArtText}>⚡</Text><Text style={styles.cableArtLabel}>CABLES</Text></View>
            </View>
            <View style={styles.sheetMeta}>
              <Text style={styles.metaLabel}>▣  PROJECT / JOB NAME:</Text><Text style={styles.metaValue}>{projectName || ' '}</Text>
              <Text style={styles.metaLabel}>●  REQUESTED BY:</Text><Text style={styles.metaValue}>{requestedBy || ' '}</Text>
            </View>
            {renderRequirementSection('cable', cableItems)}
            {renderRequirementSection('wire', wireItems)}
          </View>
        </ViewShot>
      </ScrollView>


      <Modal visible={catalogManagerVisible} transparent animationType="fade" onRequestClose={() => setCatalogManagerVisible(false)}>
        <View style={styles.modalOverlay}>
          <SafeAreaView style={styles.catalogManagerSafeArea} edges={['top', 'bottom']}>
            <View style={styles.catalogManagerCard}>
              <TouchableOpacity style={styles.closeButton} onPress={() => setCatalogManagerVisible(false)}>
                <Text style={styles.closeText}>✕</Text>
              </TouchableOpacity>
              <Text style={styles.modalTitle}>Cable / Wire Catalog</Text>
              <Text style={styles.catalogManagerSubtitle}>
                Owner maintenance for reusable suggestions stored in Firebase.
              </Text>
              <TextInput
                style={styles.input}
                value={catalogManagerSearch}
                onChangeText={(value) => {
                  setCatalogManagerSearch(value);
                  setCatalogManagerPage(1);
                }}
                placeholder="Search saved cable or wire names"
                placeholderTextColor="#64748b"
              />
              <View style={styles.catalogManagerSummary}>
                <Text style={styles.catalogManagerSummaryText}>
                  {filteredManagedCatalog.length} saved names • Page {catalogManagerPage} of {catalogManagerPageCount}
                </Text>
              </View>
              <ScrollView style={styles.catalogManagerList} contentContainerStyle={styles.catalogManagerListContent}>
                {visibleManagedCatalog.length ? visibleManagedCatalog.map((entry) => (
                  <View key={entry.id} style={styles.catalogManagerRow}>
                    <View style={[styles.catalogTypeBadge, entry.type === 'wire' && styles.catalogTypeBadgeWire]}>
                      <Text style={styles.catalogTypeBadgeText}>{TYPE_LABELS[entry.type] || 'Cable'}</Text>
                    </View>
                    <Text style={styles.catalogManagerName}>{normalizeCableWireName(entry.name)}</Text>
                    <TouchableOpacity
                      style={styles.catalogManagerEditButton}
                      onPress={() => openCableCatalogEntryEditor(entry)}
                      disabled={catalogMaintenanceBusy}
                    >
                      <Text style={styles.catalogManagerActionText}>✎</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={styles.catalogManagerDeleteButton}
                      onPress={() => deleteCableCatalogMaintenanceEntry(entry)}
                      disabled={catalogMaintenanceBusy}
                    >
                      <Text style={styles.catalogManagerDeleteText}>✕</Text>
                    </TouchableOpacity>
                  </View>
                )) : (
                  <Text style={styles.catalogManagerEmpty}>No catalog names match this search.</Text>
                )}
              </ScrollView>
              <View style={styles.catalogPagination}>
                <TouchableOpacity
                  style={[styles.catalogPageButton, catalogManagerPage <= 1 && styles.disabledButton]}
                  disabled={catalogManagerPage <= 1}
                  onPress={() => setCatalogManagerPage((page) => Math.max(1, page - 1))}
                >
                  <Text style={styles.catalogPageButtonText}>‹ Previous</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.catalogPageButton, catalogManagerPage >= catalogManagerPageCount && styles.disabledButton]}
                  disabled={catalogManagerPage >= catalogManagerPageCount}
                  onPress={() => setCatalogManagerPage((page) => Math.min(catalogManagerPageCount, page + 1))}
                >
                  <Text style={styles.catalogPageButtonText}>Next ›</Text>
                </TouchableOpacity>
              </View>
            </View>
          </SafeAreaView>
        </View>
      </Modal>

      <Modal visible={catalogEntryEditorVisible} transparent animationType="fade" onRequestClose={() => setCatalogEntryEditorVisible(false)}>
        <KeyboardAvoidingView style={styles.modalOverlay} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
          <SafeAreaView style={styles.modalSafeArea} edges={['top', 'bottom']}>
            <View style={styles.catalogEntryEditorCard}>
              <TouchableOpacity style={styles.closeButton} onPress={() => setCatalogEntryEditorVisible(false)}>
                <Text style={styles.closeText}>✕</Text>
              </TouchableOpacity>
              <Text style={styles.modalTitle}>Edit Catalog Name</Text>
              <Text style={styles.label}>Type</Text>
              <View style={styles.actionRow}>
                {['cable', 'wire'].map((type) => (
                  <TouchableOpacity
                    key={type}
                    style={[styles.typeButton, catalogEntryEditor.type === type && styles.typeButtonSelected]}
                    onPress={() => setCatalogEntryEditor((old) => ({ ...old, type }))}
                  >
                    <Text style={[styles.typeButtonText, catalogEntryEditor.type === type && styles.typeButtonTextSelected]}>
                      {TYPE_LABELS[type]}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
              <Text style={styles.label}>Standardized Name</Text>
              <TextInput
                style={styles.input}
                value={catalogEntryEditor.name}
                onChangeText={(name) => setCatalogEntryEditor((old) => ({ ...old, name }))}
                onBlur={() => setCatalogEntryEditor((old) => ({ ...old, name: normalizeCableWireName(old.name) }))}
                autoCapitalize="characters"
                placeholder="Example: 4C # 12"
                placeholderTextColor="#64748b"
              />
              {!!catalogEntryEditor.name.trim() && (
                <Text style={styles.catalogNormalizedPreview}>
                  Saved as: {normalizeCableWireName(catalogEntryEditor.name)}
                </Text>
              )}
              <TouchableOpacity
                style={[styles.saveButton, catalogMaintenanceBusy && styles.disabledButton]}
                onPress={saveCableCatalogMaintenanceEntry}
                disabled={catalogMaintenanceBusy}
              >
                <Text style={styles.saveButtonText}>{catalogMaintenanceBusy ? 'Saving...' : 'Save Catalog Entry'}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.cancelButton} onPress={() => setCatalogEntryEditorVisible(false)}>
                <Text style={styles.cancelButtonText}>Cancel</Text>
              </TouchableOpacity>
            </View>
          </SafeAreaView>
        </KeyboardAvoidingView>
      </Modal>

      <Modal visible={editorVisible} transparent animationType="fade" onRequestClose={() => setEditorVisible(false)}>
        <KeyboardAvoidingView style={styles.modalOverlay} behavior={Platform.OS === 'ios' ? 'padding' : 'height'} keyboardVerticalOffset={Platform.OS === 'ios' ? 20 : 0}>
          <SafeAreaView style={styles.modalSafeArea} edges={['top', 'bottom']}>
            <View style={styles.modalCard}>
              <TouchableOpacity style={styles.closeButton} onPress={() => setEditorVisible(false)}><Text style={styles.closeText}>✕</Text></TouchableOpacity>
              <ScrollView contentContainerStyle={styles.modalScroll} keyboardShouldPersistTaps="handled">
                <Text style={styles.modalTitle}>{editor.id ? 'Edit Requirement' : 'Add Requirement'}</Text>
                <Text style={styles.label}>Type</Text>
                <View style={styles.actionRow}>
                  {['cable', 'wire'].map((type) => (
                    <TouchableOpacity key={type} style={[styles.typeButton, editor.type === type && styles.typeButtonSelected]} onPress={() => setEditor((old) => ({ ...old, type }))}>
                      <Text style={[styles.typeButtonText, editor.type === type && styles.typeButtonTextSelected]}>{TYPE_LABELS[type]}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
                <Text style={styles.label}>Cable / Wire Name</Text>
                <TextInput
                  style={styles.input}
                  value={editor.name}
                  onChangeText={(name) => setEditor((old) => ({ ...old, name }))}
                  onBlur={() => {
                    const normalizedName = normalizeCableWireName(editor.name);
                    if (normalizedName) setEditor((old) => ({ ...old, name: normalizedName }));
                  }}
                  autoCapitalize="characters"
                  placeholder="Example: 4C#12 or 7C #14"
                  placeholderTextColor="#64748b"
                />
                {showNormalizedNameSuggestion && (
                  <TouchableOpacity
                    style={styles.normalizedSuggestion}
                    onPress={() => setEditor((old) => ({ ...old, name: normalizedEditorName }))}
                  >
                    <Text style={styles.normalizedSuggestionLabel}>Corrected format</Text>
                    <Text style={styles.normalizedSuggestionText}>{normalizedEditorName}</Text>
                    <Text style={styles.normalizedSuggestionHint}>Tap to use this standardized name</Text>
                  </TouchableOpacity>
                )}
                {!!matchingSuggestions.length && (
                  <View style={styles.suggestionsBox}>
                    <Text style={styles.suggestionsTitle}>Saved suggestions</Text>
                    {matchingSuggestions.map((entry, index) => (
                      <TouchableOpacity
                        key={entry.id}
                        style={[
                          styles.suggestion,
                          index === matchingSuggestions.length - 1 && styles.suggestionLast,
                        ]}
                        onPress={() => applyCatalogSuggestion(entry)}
                      >
                        <Text style={styles.suggestionIcon}>↳</Text>
                        <Text style={styles.suggestionText}>{entry.name}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                )}
                <Text style={styles.label}>Length (FT/IN)</Text>
                <TextInput style={styles.input} value={editor.length} onChangeText={(length) => setEditor((old) => ({ ...old, length }))} placeholder={"Example: 250 ft or 12 ft 6 in"} placeholderTextColor="#64748b" />
                {!editor.id && (
                  <TouchableOpacity style={styles.checkboxRow} onPress={() => setEditor((old) => ({ ...old, saveToCatalog: !old.saveToCatalog }))}>
                    <Text style={styles.checkbox}>{editor.saveToCatalog ? '☑' : '☐'}</Text><Text style={styles.checkboxLabel}>Add this new name to Firebase without asking</Text>
                  </TouchableOpacity>
                )}
                <TouchableOpacity disabled={saving} style={styles.saveButton} onPress={saveEditor}><Text style={styles.saveButtonText}>{saving ? 'Saving...' : 'Save Item'}</Text></TouchableOpacity>
                <TouchableOpacity style={styles.cancelButton} onPress={() => setEditorVisible(false)}><Text style={styles.cancelButtonText}>Cancel</Text></TouchableOpacity>
              </ScrollView>
            </View>
          </SafeAreaView>
        </KeyboardAvoidingView>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#0a192f' },
  content: { padding: 16 },
  pageTitle: { color: '#64ffda', fontSize: 24, fontWeight: '900', textAlign: 'center' },
  pageSubtitle: { color: '#a8b2d1', textAlign: 'center', marginBottom: 18 },
  label: { color: '#ccd6f6', fontWeight: '800', marginTop: 12, marginBottom: 6 },
  input: { backgroundColor: '#fff', borderRadius: 10, paddingHorizontal: 13, minHeight: 48, color: '#0a192f', borderWidth: 1, borderColor: '#94a3b8' },
  actionRow: { flexDirection: 'row', gap: 10, marginTop: 12 },
  addButton: { flex: 1, backgroundColor: '#0b6edb', padding: 14, borderRadius: 10, alignItems: 'center' },
  addButtonText: { color: '#fff', fontWeight: '900' },
  editorListRow: { marginTop: 10, backgroundColor: '#172a45', borderRadius: 12, padding: 12, flexDirection: 'row', alignItems: 'center', gap: 10 },
  typePill: { backgroundColor: '#64ffda', paddingHorizontal: 9, paddingVertical: 5, borderRadius: 12 },
  typePillText: { color: '#0a192f', fontWeight: '900' },
  rowName: { color: '#fff', fontWeight: '800' }, rowLength: { color: '#a8b2d1' },
  smallButton: { backgroundColor: '#e2e8f0', width: 36, height: 36, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  shareButton: { backgroundColor: '#12a86b', padding: 15, borderRadius: 12, alignItems: 'center', marginTop: 16 },
  shareButtonText: { color: '#fff', fontWeight: '900' },
  pdfButton: { backgroundColor: '#b45309', padding: 15, borderRadius: 12, alignItems: 'center', marginTop: 10 },
  disabledButton: { opacity: 0.55 },
  clearButton: { borderWidth: 1, borderColor: '#ff6b6b', padding: 13, borderRadius: 12, alignItems: 'center', marginTop: 10 },
  clearButtonText: { color: '#ff6b6b', fontWeight: '900' },
  captureWrapper: { marginTop: 24 },
  requirementSheet: { backgroundColor: '#f8fafc', borderRadius: 12, overflow: 'hidden', paddingBottom: 22 },
  heroHeader: { backgroundColor: '#052a4a', paddingHorizontal: 20, paddingVertical: 16, flexDirection: 'row', minHeight: 112, alignItems: 'center' },
  heroTitleContainer: { flex: 1, justifyContent: 'center', paddingRight: 8 },
  heroTitle: { color: '#fff', fontWeight: '900', letterSpacing: 0.4, flexShrink: 1 },
  heroTitleLong: { fontSize: 22, lineHeight: 25 },
  heroTitleShort: { fontSize: 25, lineHeight: 28 },
  blueUnderline: { width: 88, height: 4, backgroundColor: '#0ea5e9', marginTop: 9 },
  cableArt: { width: 82, alignItems: 'center', justifyContent: 'center' }, cableArtText: { fontSize: 40 }, cableArtLabel: { color: '#38bdf8', fontWeight: '900', fontSize: 11 },
  sheetMeta: { padding: 20 },
  metaLabel: { color: '#092f55', fontWeight: '900', marginTop: 8 },
  metaValue: { color: '#111827', minHeight: 28, borderBottomWidth: 1, borderBottomColor: '#94a3b8', marginBottom: 5, paddingVertical: 4 },
  sheetSection: { marginHorizontal: 16, marginTop: 12, borderWidth: 1, borderColor: '#94a3b8', borderRadius: 8, overflow: 'hidden' },
  sectionTitleBar: { backgroundColor: '#052a4a', padding: 10 }, sectionTitleText: { color: '#fff', textAlign: 'center', fontWeight: '900', fontSize: 18 },
  tableHeader: { flexDirection: 'row', backgroundColor: '#07345d' }, tableRow: { flexDirection: 'row', minHeight: 48, backgroundColor: '#fff' },
  headerCell: { color: '#fff', fontWeight: '900', textAlign: 'center', padding: 9, borderRightWidth: 1, borderBottomWidth: 1, borderColor: '#94a3b8' },
  bodyCell: { color: '#111827', textAlign: 'center', padding: 10, borderRightWidth: 1, borderBottomWidth: 2, borderColor: '#94a3b8' },
  numberColumn: { width: '18%' }, descriptionColumn: { width: '52%' }, lengthColumn: { width: '30%' }, itemNumber: { color: '#0b4a83', fontWeight: '900' },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(2,12,27,0.82)', justifyContent: 'center' },
  modalSafeArea: { flex: 1, justifyContent: 'center', padding: 14 },
  modalCard: { maxHeight: '88%', backgroundColor: '#dbe7ff', borderRadius: 18, overflow: 'hidden' },
  modalScroll: { padding: 20, paddingTop: 55, paddingBottom: 28 },
  closeButton: { position: 'absolute', zIndex: 5, top: 10, right: 10, width: 42, height: 42, borderRadius: 21, backgroundColor: '#0a192f', alignItems: 'center', justifyContent: 'center' },
  closeText: { color: '#fff', fontSize: 20, fontWeight: '900' }, modalTitle: { color: '#0a192f', fontWeight: '900', fontSize: 22, textAlign: 'center' },
  typeButton: { flex: 1, backgroundColor: '#fff', borderWidth: 1, borderColor: '#94a3b8', padding: 12, borderRadius: 10, alignItems: 'center' },
  typeButtonSelected: { backgroundColor: '#0b6edb' }, typeButtonText: { color: '#0a192f', fontWeight: '900' }, typeButtonTextSelected: { color: '#fff' },
  suggestionsBox: { backgroundColor: '#dff4ff', borderRadius: 10, marginTop: 6, borderWidth: 1, borderColor: '#38bdf8', overflow: 'hidden' },
  suggestionsTitle: { color: '#075985', fontWeight: '900', fontSize: 12, paddingHorizontal: 11, paddingTop: 9, paddingBottom: 6, textTransform: 'uppercase', letterSpacing: 0.5 },
  suggestion: { paddingHorizontal: 11, paddingVertical: 11, borderBottomWidth: 1, borderBottomColor: '#7dd3fc', backgroundColor: '#bae6fd', flexDirection: 'row', alignItems: 'center', gap: 8 },
  suggestionLast: { borderBottomWidth: 0 },
  suggestionIcon: { color: '#0369a1', fontSize: 17, fontWeight: '900' },
  suggestionText: { color: '#0c4a6e', fontWeight: '800', flex: 1 },
  checkboxRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 16 }, checkbox: { fontSize: 22, color: '#0b6edb' }, checkboxLabel: { color: '#0a192f', flex: 1, fontWeight: '700' },
  saveButton: { backgroundColor: '#0b6edb', padding: 15, borderRadius: 10, alignItems: 'center', marginTop: 18 }, saveButtonText: { color: '#fff', fontWeight: '900' },
  cancelButton: { borderWidth: 1, borderColor: '#475569', padding: 13, borderRadius: 10, alignItems: 'center', marginTop: 10 }, cancelButtonText: { color: '#0a192f', fontWeight: '900' },

  manageCatalogButton: {
    backgroundColor: '#172a45',
    borderWidth: 1,
    borderColor: '#64ffda',
    padding: 13,
    borderRadius: 11,
    alignItems: 'center',
    marginTop: 10,
  },
  manageCatalogButtonText: { color: '#64ffda', fontWeight: '900' },
  normalizedSuggestion: {
    marginTop: 8,
    backgroundColor: '#e0f2fe',
    borderWidth: 1,
    borderColor: '#0284c7',
    borderRadius: 10,
    padding: 11,
  },
  normalizedSuggestionLabel: { color: '#075985', fontSize: 11, fontWeight: '900', textTransform: 'uppercase' },
  normalizedSuggestionText: { color: '#0c4a6e', fontSize: 17, fontWeight: '900', marginTop: 3 },
  normalizedSuggestionHint: { color: '#0369a1', fontSize: 11, marginTop: 3 },
  catalogManagerSafeArea: { flex: 1, width: '100%', paddingHorizontal: 12, paddingVertical: 16 },
  catalogManagerCard: {
    flex: 1,
    backgroundColor: '#f8fafc',
    borderRadius: 18,
    padding: 18,
    paddingTop: 52,
    maxWidth: 720,
    width: '100%',
    alignSelf: 'center',
  },
  catalogManagerSubtitle: { color: '#475569', textAlign: 'center', marginBottom: 12, lineHeight: 18 },
  catalogManagerSummary: { backgroundColor: '#e2e8f0', borderRadius: 9, padding: 9, marginTop: 10 },
  catalogManagerSummaryText: { color: '#334155', fontWeight: '800', textAlign: 'center' },
  catalogManagerList: { flex: 1, marginTop: 10 },
  catalogManagerListContent: { paddingBottom: 10 },
  catalogManagerRow: {
    minHeight: 58,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#cbd5e1',
    borderRadius: 10,
    padding: 9,
    marginBottom: 8,
  },
  catalogTypeBadge: { backgroundColor: '#dbeafe', borderRadius: 999, paddingHorizontal: 8, paddingVertical: 5 },
  catalogTypeBadgeWire: { backgroundColor: '#dcfce7' },
  catalogTypeBadgeText: { color: '#0f172a', fontSize: 11, fontWeight: '900' },
  catalogManagerName: { flex: 1, color: '#0f172a', fontWeight: '800', fontSize: 14 },
  catalogManagerEditButton: { width: 38, height: 38, borderRadius: 8, backgroundColor: '#e0f2fe', alignItems: 'center', justifyContent: 'center' },
  catalogManagerDeleteButton: { width: 38, height: 38, borderRadius: 8, backgroundColor: '#fee2e2', alignItems: 'center', justifyContent: 'center' },
  catalogManagerActionText: { color: '#0369a1', fontWeight: '900', fontSize: 18 },
  catalogManagerDeleteText: { color: '#dc2626', fontWeight: '900', fontSize: 18 },
  catalogManagerEmpty: { color: '#64748b', textAlign: 'center', padding: 24 },
  catalogPagination: { flexDirection: 'row', gap: 10, paddingTop: 8 },
  catalogPageButton: { flex: 1, backgroundColor: '#0b6edb', borderRadius: 10, padding: 12, alignItems: 'center' },
  catalogPageButtonText: { color: '#fff', fontWeight: '900' },
  catalogEntryEditorCard: {
    backgroundColor: '#f8fafc',
    borderRadius: 18,
    padding: 18,
    paddingTop: 52,
    width: '94%',
    maxWidth: 560,
    alignSelf: 'center',
  },
  catalogNormalizedPreview: { color: '#0369a1', fontWeight: '800', marginTop: 8, marginBottom: 4 },

});

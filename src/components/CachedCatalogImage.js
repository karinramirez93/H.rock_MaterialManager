import React, { useEffect, useState } from 'react';
import { Image, View, Text, StyleSheet } from 'react-native';
import { StorageService } from '../database/storage';

/**
 * CachedCatalogImage
 * ------------------
 * Catalog images are only visual references, so they should be downloaded as
 * small thumbnails and cached locally. This component requests the local cached
 * URI only when the row is rendered. That means paging/searching the catalog no
 * longer downloads every image in Firebase.
 */
export default function CachedCatalogImage({ material, uri, style, placeholderStyle, placeholderTextStyle, resizeMode = 'contain' }) {
  const [localUri, setLocalUri] = useState(uri || material?.imageUri || '');

  useEffect(() => {
    let mounted = true;
    const sourceUri = uri || material?.imageUri || material?.groupCoverUri || '';
    setLocalUri(sourceUri);

    if (!sourceUri) return () => { mounted = false; };

    StorageService.getCatalogThumbnailForDisplay({ ...(material || {}), imageUri: sourceUri })
      .then((cachedUri) => {
        if (mounted && cachedUri) setLocalUri(cachedUri);
      })
      .catch(() => {
        if (mounted) setLocalUri(sourceUri);
      });

    return () => { mounted = false; };
  }, [uri, material?.id, material?.imageUri, material?.groupCoverUri, material?.updatedAt]);

  if (!localUri) {
    return (
      <View style={[styles.placeholder, placeholderStyle]}>
        <Text style={[styles.placeholderText, placeholderTextStyle]}>No Photo</Text>
      </View>
    );
  }

  return <Image source={{ uri: localUri }} style={style} resizeMode={resizeMode} />;
}

const styles = StyleSheet.create({
  placeholder: {
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#172a45',
    borderWidth: 1,
    borderColor: '#233554',
  },
  placeholderText: {
    color: '#8892b0',
    fontSize: 9,
    fontWeight: 'bold',
  },
});

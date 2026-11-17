use crate::common::{CoreResult, MarkerId};
use crate::storage::traits::Storage;
use crate::storage::state::APP_STATE;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BunnyCacheData {
    pub marker_id: MarkerId,
    pub original_text: Option<String>,
    pub machine_translation: Option<String>,
    pub last_ocr_model: Option<String>,
    pub last_translation_service: Option<String>,
}

impl BunnyCacheData {
    pub fn new(marker_id: MarkerId) -> Self {
        Self {
            marker_id,
            original_text: None,
            machine_translation: None,
            last_ocr_model: None,
            last_translation_service: None,
        }
    }
}

#[derive(Debug, Default)]
pub struct BunnyCacheStorage {
    pub(crate) cache: HashMap<MarkerId, BunnyCacheData>,
}

impl Storage<MarkerId, BunnyCacheData> for BunnyCacheStorage {
    type Iter<'a> = std::collections::hash_map::Iter<'a, MarkerId, BunnyCacheData> where Self: 'a;

    fn insert(&mut self, key: MarkerId, value: BunnyCacheData) -> CoreResult<()> {
        self.cache.insert(key, value);
        Ok(())
    }

    fn get(&self, key: &MarkerId) -> Option<&BunnyCacheData> {
        self.cache.get(key)
    }

    fn get_mut(&mut self, key: &MarkerId) -> Option<&mut BunnyCacheData> {
        self.cache.get_mut(key)
    }

    fn remove(&mut self, key: &MarkerId) -> Option<BunnyCacheData> {
        self.cache.remove(key)
    }

    fn contains(&self, key: &MarkerId) -> bool {
        self.cache.contains_key(key)
    }

    fn clear(&mut self) {
        self.cache.clear();
    }

    fn iter(&self) -> Self::Iter<'_> {
        self.cache.iter()
    }
}

pub fn get_bunny_cache_storage(marker_id: MarkerId) -> CoreResult<Option<BunnyCacheData>> {
    let storage = APP_STATE.bunny_cache.read()?;
    Ok(storage.get(&marker_id).cloned())
}

pub fn update_original_text_storage(
    marker_id: MarkerId,
    text: String,
    model: String,
) -> CoreResult<()> {
    let mut storage = APP_STATE.bunny_cache.write()?;

    if let Some(cache_data) = storage.get_mut(&marker_id) {
        cache_data.original_text = Some(text);
        cache_data.last_ocr_model = Some(model);
    } else {
        let mut cache_data = BunnyCacheData::new(marker_id);
        cache_data.original_text = Some(text);
        cache_data.last_ocr_model = Some(model);
        storage.insert(marker_id, cache_data)?;
    }

    Ok(())
}

pub fn update_machine_translation_storage(
    marker_id: MarkerId,
    text: String,
    service: String,
) -> CoreResult<()> {
    let mut storage = APP_STATE.bunny_cache.write()?;

    if let Some(cache_data) = storage.get_mut(&marker_id) {
        cache_data.machine_translation = Some(text);
        cache_data.last_translation_service = Some(service);
    } else {
        let mut cache_data = BunnyCacheData::new(marker_id);
        cache_data.machine_translation = Some(text);
        cache_data.last_translation_service = Some(service);
        storage.insert(marker_id, cache_data)?;
    }

    Ok(())
}

pub fn clear_bunny_cache_storage(marker_id: MarkerId) -> CoreResult<()> {
    let mut storage = APP_STATE.bunny_cache.write()?;
    storage.remove(&marker_id);
    Ok(())
}

pub fn clear_all_bunny_cache_storage() -> CoreResult<()> {
    let mut storage = APP_STATE.bunny_cache.write()?;
    storage.clear();
    Ok(())
}
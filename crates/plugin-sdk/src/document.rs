//! Typed host helpers shared by the native and WASM adapters.
use crate::*;
use serde::de::DeserializeOwned;
use serde_json::json;

/// Encoded bytes remain separate from the image metadata on every transport.
#[derive(Clone, Debug)]
pub struct ImageBytes {
    pub metadata: PluginImageRead,
    pub binary: Vec<u8>,
}

impl PluginContext<'_> {
    /// Allocate an ID before constructing a transaction; subsequent operations
    /// in that transaction may refer to it.
    pub fn create_id(&mut self) -> String {
        *self.next_call += 1;
        #[cfg(not(target_arch = "wasm32"))]
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        #[cfg(target_arch = "wasm32")]
        let nonce =
            ((js_sys::Date::now() as u128) << 64) | u128::from(js_sys::Math::random().to_bits());
        format!("{}-{nonce:x}-{:x}", self.plugin_id, self.next_call)
    }

    async fn typed_call<T: DeserializeOwned>(
        &mut self,
        method: &str,
        params: Value,
    ) -> Result<T, PluginRpcError> {
        let output = self.call_host(method, params, vec![], None).await?;
        serde_json::from_value(output.result)
            .map_err(|error| PluginRpcError::new("invalidHostResponse", error.to_string()))
    }

    /// Legacy read projection is intentionally retained alongside the typed APIs.
    pub async fn document_read(&mut self, query: Value) -> Result<Value, PluginRpcError> {
        self.typed_call("document.read", query).await
    }
    pub async fn transaction(
        &mut self,
        transaction: PluginTransaction,
    ) -> Result<Value, PluginRpcError> {
        self.typed_call(
            "document.transaction",
            serde_json::to_value(transaction).unwrap(),
        )
        .await
    }
    pub async fn apply_operation(
        &mut self,
        project_id: &str,
        label: &str,
        operation: PluginOperation,
    ) -> Result<Value, PluginRpcError> {
        self.transaction(PluginTransaction {
            project_id: project_id.into(),
            label: label.into(),
            operations: vec![operation],
            expected_state_id: None,
            causation_id: None,
        })
        .await
    }
    pub async fn images_list(
        &mut self,
        project_id: &str,
    ) -> Result<Vec<PluginImage>, PluginRpcError> {
        self.typed_call("document.images.list", json!({"projectId":project_id}))
            .await
    }
    pub async fn images_get(
        &mut self,
        project_id: &str,
        image_id: &str,
    ) -> Result<Option<PluginImage>, PluginRpcError> {
        self.typed_call(
            "document.images.get",
            json!({"projectId":project_id,"imageId":image_id}),
        )
        .await
    }
    /// Read a lease owned by this instance, or one fixed by the current hook proposal.
    pub async fn images_get_staged(
        &mut self,
        project_id: &str,
        staged_resource: &str,
    ) -> Result<Option<PluginImage>, PluginRpcError> {
        self.typed_call(
            "document.images.get",
            json!({"projectId":project_id,"stagedResource":staged_resource}),
        )
        .await
    }
    pub async fn images_read(
        &mut self,
        project_id: &str,
        image_id: &str,
        region: Option<PluginImageRegion>,
    ) -> Result<ImageBytes, PluginRpcError> {
        let mut query = json!({"projectId":project_id,"imageId":image_id});
        self.read_image_query(&mut query, region).await
    }
    pub async fn images_read_staged(
        &mut self,
        project_id: &str,
        staged_resource: &str,
        region: Option<PluginImageRegion>,
    ) -> Result<ImageBytes, PluginRpcError> {
        let mut query = json!({"projectId":project_id,"stagedResource":staged_resource});
        self.read_image_query(&mut query, region).await
    }
    async fn read_image_query(
        &mut self,
        query: &mut Value,
        region: Option<PluginImageRegion>,
    ) -> Result<ImageBytes, PluginRpcError> {
        if let Some(region) = region {
            query["region"] = serde_json::to_value(region).unwrap();
        }
        let output = self
            .call_host("document.images.read", query.take(), vec![], None)
            .await?;
        let metadata: PluginImageRead = serde_json::from_value(output.result)
            .map_err(|error| PluginRpcError::new("invalidHostResponse", error.to_string()))?;
        if metadata.byte_length as usize != output.binary.len() {
            return Err(PluginRpcError::new(
                "invalidHostResponse",
                "Image metadata does not match attached bytes",
            ));
        }
        Ok(ImageBytes {
            metadata,
            binary: output.binary,
        })
    }
    pub async fn images_stage(
        &mut self,
        project_id: &str,
        filename: Option<&str>,
        binary: Vec<u8>,
    ) -> Result<PluginStagedImage, PluginRpcError> {
        let mut query = json!({"projectId":project_id});
        if let Some(filename) = filename {
            query["filename"] = json!(filename);
        }
        let output = self
            .call_host("document.images.stage", query, binary, None)
            .await?;
        serde_json::from_value(output.result)
            .map_err(|error| PluginRpcError::new("invalidHostResponse", error.to_string()))
    }
    pub async fn images_create(
        &mut self,
        project_id: &str,
        id: &str,
        staged_resource: &str,
        filename: Option<String>,
    ) -> Result<Value, PluginRpcError> {
        self.apply_operation(
            project_id,
            "image.create",
            PluginOperation::ImageCreate {
                id: id.into(),
                staged_resource: staged_resource.into(),
                filename,
            },
        )
        .await
    }
    pub async fn images_update(
        &mut self,
        project_id: &str,
        image_id: &str,
        staged_resource: Option<String>,
        filename: Option<String>,
    ) -> Result<Value, PluginRpcError> {
        self.apply_operation(
            project_id,
            "image.update",
            PluginOperation::ImageUpdate {
                image_id: image_id.into(),
                staged_resource,
                filename,
            },
        )
        .await
    }
    pub async fn images_remove(
        &mut self,
        project_id: &str,
        image_id: &str,
    ) -> Result<Value, PluginRpcError> {
        self.apply_operation(
            project_id,
            "image.remove",
            PluginOperation::ImageRemove {
                image_id: image_id.into(),
            },
        )
        .await
    }
    pub async fn images_reorder(
        &mut self,
        project_id: &str,
        image_ids: Vec<String>,
    ) -> Result<Value, PluginRpcError> {
        self.apply_operation(
            project_id,
            "image.reorder",
            PluginOperation::ImageReorder { image_ids },
        )
        .await
    }
    pub async fn markers_list(
        &mut self,
        project_id: &str,
        image_id: &str,
    ) -> Result<Vec<PluginMarker>, PluginRpcError> {
        self.typed_call(
            "document.markers.list",
            json!({"projectId":project_id,"imageId":image_id}),
        )
        .await
    }
    pub async fn markers_get(
        &mut self,
        project_id: &str,
        image_id: &str,
        marker_id: &str,
    ) -> Result<Option<PluginMarker>, PluginRpcError> {
        self.typed_call(
            "document.markers.get",
            json!({"projectId":project_id,"imageId":image_id,"markerId":marker_id}),
        )
        .await
    }
    pub async fn markers_create(
        &mut self,
        project_id: &str,
        image_id: &str,
        marker: PluginMarker,
    ) -> Result<Value, PluginRpcError> {
        self.apply_operation(
            project_id,
            "marker.create",
            PluginOperation::MarkerCreate {
                image_id: image_id.into(),
                marker,
            },
        )
        .await
    }
    pub async fn markers_update(
        &mut self,
        project_id: &str,
        image_id: &str,
        marker_id: &str,
        geometry: Option<PluginGeometry>,
        translation: Option<PluginRichText>,
        style: Option<PluginMarkerStyle>,
    ) -> Result<Value, PluginRpcError> {
        self.apply_operation(
            project_id,
            "marker.update",
            PluginOperation::MarkerUpdate {
                image_id: image_id.into(),
                marker_id: marker_id.into(),
                geometry,
                translation,
                style,
            },
        )
        .await
    }
    pub async fn markers_remove(
        &mut self,
        project_id: &str,
        image_id: &str,
        marker_id: &str,
    ) -> Result<Value, PluginRpcError> {
        self.apply_operation(
            project_id,
            "marker.remove",
            PluginOperation::MarkerRemove {
                image_id: image_id.into(),
                marker_id: marker_id.into(),
            },
        )
        .await
    }
    pub async fn markers_reorder(
        &mut self,
        project_id: &str,
        image_id: &str,
        marker_ids: Vec<String>,
    ) -> Result<Value, PluginRpcError> {
        self.apply_operation(
            project_id,
            "marker.reorder",
            PluginOperation::MarkerReorder {
                image_id: image_id.into(),
                marker_ids,
            },
        )
        .await
    }
    pub async fn translations_get(
        &mut self,
        project_id: &str,
        image_id: &str,
        marker_id: &str,
    ) -> Result<PluginRichText, PluginRpcError> {
        self.typed_call(
            "document.translations.get",
            json!({"projectId":project_id,"imageId":image_id,"markerId":marker_id}),
        )
        .await
    }
    pub async fn translations_set(
        &mut self,
        project_id: &str,
        image_id: &str,
        marker_id: &str,
        value: PluginTranslation,
    ) -> Result<Value, PluginRpcError> {
        self.apply_operation(
            project_id,
            "translation.set",
            PluginOperation::TranslationSet {
                image_id: image_id.into(),
                marker_id: marker_id.into(),
                value,
            },
        )
        .await
    }
    pub async fn translations_clear(
        &mut self,
        project_id: &str,
        image_id: &str,
        marker_id: &str,
    ) -> Result<Value, PluginRpcError> {
        self.apply_operation(
            project_id,
            "translation.clear",
            PluginOperation::TranslationClear {
                image_id: image_id.into(),
                marker_id: marker_id.into(),
            },
        )
        .await
    }
    pub async fn assistance_get(
        &mut self,
        project_id: &str,
        image_id: &str,
        marker_id: &str,
    ) -> Result<Value, PluginRpcError> {
        self.typed_call(
            "document.assistance.get",
            json!({"projectId":project_id,"imageId":image_id,"markerId":marker_id}),
        )
        .await
    }
    pub async fn assistance_update(
        &mut self,
        project_id: &str,
        image_id: &str,
        marker_id: &str,
        patch: PluginAssistancePatch,
        expected: Option<PluginAssistanceExpected>,
    ) -> Result<Value, PluginRpcError> {
        self.apply_operation(
            project_id,
            "assistance.update",
            PluginOperation::AssistanceUpdate {
                image_id: image_id.into(),
                marker_id: marker_id.into(),
                patch,
                expected,
            },
        )
        .await
    }
    pub async fn assistance_clear(
        &mut self,
        project_id: &str,
        image_id: &str,
        marker_id: &str,
    ) -> Result<Value, PluginRpcError> {
        self.apply_operation(
            project_id,
            "assistance.clear",
            PluginOperation::AssistanceClear {
                image_id: image_id.into(),
                marker_id: marker_id.into(),
            },
        )
        .await
    }
    pub async fn history_list(
        &mut self,
        query: PluginHistoryQuery,
    ) -> Result<PluginHistoryPage, PluginRpcError> {
        self.typed_call("history.list", serde_json::to_value(query).unwrap())
            .await
    }
    pub async fn history_push(
        &mut self,
        transaction: PluginTransaction,
    ) -> Result<Value, PluginRpcError> {
        self.transaction(transaction).await
    }
    pub async fn history_pop(
        &mut self,
        stack: PluginHistoryStack,
        query: PluginHistoryControl,
    ) -> Result<Value, PluginRpcError> {
        let mut params = serde_json::to_value(query).unwrap();
        params["stack"] = serde_json::to_value(stack).unwrap();
        self.typed_call("history.pop", params).await
    }
    pub async fn history_undo(
        &mut self,
        query: PluginHistoryControl,
    ) -> Result<Value, PluginRpcError> {
        self.history_pop(PluginHistoryStack::Undo, query).await
    }
    pub async fn history_redo(
        &mut self,
        query: PluginHistoryControl,
    ) -> Result<Value, PluginRpcError> {
        self.history_pop(PluginHistoryStack::Redo, query).await
    }
    pub async fn events_subscribe(
        &mut self,
        event: &str,
        options: PluginEventOptions,
    ) -> Result<String, PluginRpcError> {
        let subscription_id = self.create_id();
        self.call_host(
            "events.subscribe",
            json!({"event":event,"subscriptionId":subscription_id,"options":options}),
            vec![],
            None,
        )
        .await?;
        Ok(subscription_id)
    }
    pub async fn events_unsubscribe(
        &mut self,
        event: &str,
        subscription_id: &str,
    ) -> Result<(), PluginRpcError> {
        self.call_host(
            "events.unsubscribe",
            json!({"event":event,"subscriptionId":subscription_id}),
            vec![],
            None,
        )
        .await?;
        Ok(())
    }
    pub async fn register_before_commit(
        &mut self,
        info: BeforeCommitHookInfo,
    ) -> Result<(), PluginRpcError> {
        // The main role may share one activate implementation with the hook role.
        if self.runtime_role != PluginRuntimeRole::Hooks {
            return Ok(());
        }
        self.call_host("hooks.register", json!({"info":info}), vec![], None)
            .await?;
        Ok(())
    }
    pub async fn unregister_before_commit(&mut self, id: &str) -> Result<(), PluginRpcError> {
        self.call_host("hooks.unregister", json!({"id":id}), vec![], None)
            .await?;
        Ok(())
    }
}

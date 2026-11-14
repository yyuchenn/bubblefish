//! Local model/resource storage is separate from document state and plugin code.
use crate::*;
use serde::de::DeserializeOwned;
use serde_json::json;

impl PluginContext<'_> {
    async fn local_call<T: DeserializeOwned>(
        &mut self,
        method: &str,
        params: Value,
        binary: Vec<u8>,
    ) -> Result<T, PluginRpcError> {
        let output = self.call_host(method, params, binary, None).await?;
        serde_json::from_value(output.result)
            .map_err(|error| PluginRpcError::new("invalidHostResponse", error.to_string()))
    }
    pub async fn resources_local_begin_import(
        &mut self,
        input: PluginLocalResourceImport,
    ) -> Result<PluginLocalResourceImportToken, PluginRpcError> {
        self.local_call(
            "resources.local.beginImport",
            serde_json::to_value(input).unwrap(),
            vec![],
        )
        .await
    }
    pub async fn resources_local_write_chunk(
        &mut self,
        token: &str,
        path: &str,
        offset: u64,
        binary: Vec<u8>,
    ) -> Result<(), PluginRpcError> {
        if binary.is_empty() || binary.len() > MAX_LOCAL_RESOURCE_CHUNK_BYTES {
            return Err(PluginRpcError::new(
                "invalidChunk",
                "Resource chunks must contain 1 byte to 4 MiB",
            ));
        }
        self.local_call(
            "resources.local.writeChunk",
            json!({"token":token,"path":path,"offset":offset}),
            binary,
        )
        .await
    }
    pub async fn resources_local_commit_import(
        &mut self,
        token: &str,
    ) -> Result<PluginLocalResourceSet, PluginRpcError> {
        self.local_call(
            "resources.local.commitImport",
            json!({"token":token}),
            vec![],
        )
        .await
    }
    pub async fn resources_local_abort_import(
        &mut self,
        token: &str,
    ) -> Result<(), PluginRpcError> {
        self.local_call(
            "resources.local.abortImport",
            json!({"token":token}),
            vec![],
        )
        .await
    }
    pub async fn resources_local_list(
        &mut self,
    ) -> Result<Vec<PluginLocalResourceSet>, PluginRpcError> {
        self.local_call("resources.local.list", json!({}), vec![])
            .await
    }
    pub async fn resources_local_read(
        &mut self,
        id: &str,
        path: &str,
    ) -> Result<Vec<u8>, PluginRpcError> {
        let output = self
            .call_host(
                "resources.local.read",
                json!({"id":id,"path":path}),
                vec![],
                None,
            )
            .await?;
        Ok(output.binary)
    }
    pub async fn resources_local_remove(&mut self, id: &str) -> Result<(), PluginRpcError> {
        self.local_call("resources.local.remove", json!({"id":id}), vec![])
            .await
    }
}

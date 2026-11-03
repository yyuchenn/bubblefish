use crate::{model::*, protocol::*, validate_document, validation::validate_parts};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    sync::Arc,
};

/// Shared image nodes make historical edits independent of the total image bytes
/// and prevent copying all pages when one marker changes.
#[derive(Clone, Debug, PartialEq)]
struct Snapshot {
    id: String,
    name: String,
    source_language: String,
    target_language: String,
    order: Vec<String>,
    images: BTreeMap<String, Arc<ImageDocument>>,
    state_id: String,
}

impl Snapshot {
    fn new(document: ProjectDocument, state_id: String) -> Self {
        let order = document.images.iter().map(|i| i.id.clone()).collect();
        let images = document
            .images
            .into_iter()
            .map(|i| (i.id.clone(), Arc::new(i)))
            .collect();
        Self {
            id: document.id,
            name: document.name,
            source_language: document.source_language,
            target_language: document.target_language,
            order,
            images,
            state_id,
        }
    }
    fn document(&self) -> ProjectDocument {
        ProjectDocument {
            id: self.id.clone(),
            name: self.name.clone(),
            source_language: self.source_language.clone(),
            target_language: self.target_language.clone(),
            images: self
                .order
                .iter()
                .map(|id| self.images[id].as_ref().clone())
                .collect(),
        }
    }
    fn image_mut(&mut self, id: &str) -> Result<&mut ImageDocument, CoreError> {
        self.images
            .get_mut(id)
            .map(Arc::make_mut)
            .ok_or_else(|| CoreError::new("imageNotFound", "The image does not exist").at(id))
    }
    fn validate(&self) -> Result<(), CoreError> {
        validate_parts(
            &self.name,
            &self.source_language,
            &self.target_language,
            self.images.values().map(AsRef::as_ref),
        )
    }
}

#[derive(Clone)]
struct HistoryEntry {
    entry_id: String,
    before: Snapshot,
    after: Snapshot,
    meta: HistoryMeta,
}

struct Project {
    current: Snapshot,
    saved_state_id: Option<String>,
    known_states: HashSet<String>,
    undo: Vec<HistoryEntry>,
    redo: Vec<HistoryEntry>,
    open_group: Option<String>,
    next_state: u64,
    next_entry: u64,
    history_revision: u64,
}

impl Project {
    fn patch(&self, before: Option<&Snapshot>, focus: Option<EditorBookmark>) -> ProjectPatch {
        let now = &self.current;
        let upsert_images = now
            .order
            .iter()
            .filter_map(|id| {
                let image = &now.images[id];
                let changed = before
                    .and_then(|b| b.images.get(id))
                    .map(|old| !Arc::ptr_eq(old, image) && old != image)
                    .unwrap_or(true);
                changed.then(|| image.clone())
            })
            .collect();
        let removed_image_ids = before
            .map(|b| {
                b.order
                    .iter()
                    .filter(|id| !now.images.contains_key(*id))
                    .cloned()
                    .collect()
            })
            .unwrap_or_default();
        ProjectPatch {
            id: now.id.clone(),
            name: now.name.clone(),
            source_language: now.source_language.clone(),
            target_language: now.target_language.clone(),
            image_order: now.order.clone(),
            upsert_images,
            removed_image_ids,
            state_id: now.state_id.clone(),
            saved_state_id: self.saved_state_id.clone(),
            can_undo: !self.undo.is_empty(),
            can_redo: !self.redo.is_empty(),
            undo_label: self.undo.last().map(|h| h.meta.label.clone()),
            redo_label: self.redo.last().map(|h| h.meta.label.clone()),
            history_depth: self.undo.len() as u32,
            history_revision: self.history_revision,
            focus,
        }
    }

    fn execute(
        &mut self,
        command: Command,
        history: Option<HistoryMeta>,
    ) -> Result<ProjectPatch, CoreError> {
        let before = self.current.clone();
        let mut focus = None;
        if let Command::GuardedUndo {
            expected_entry_id,
            expected_history_revision,
        }
        | Command::GuardedRedo {
            expected_entry_id,
            expected_history_revision,
        } = &command
        {
            let stack = if matches!(command, Command::GuardedUndo { .. }) {
                &self.undo
            } else {
                &self.redo
            };
            if expected_history_revision.is_some_and(|revision| revision != self.history_revision)
                || expected_entry_id
                    .as_ref()
                    .is_some_and(|id| stack.last().is_none_or(|entry| &entry.entry_id != id))
            {
                return Err(CoreError::new(
                    "historyConflict",
                    "The history stack changed since it was read",
                ));
            }
        }
        match command {
            Command::Undo | Command::GuardedUndo { .. } => {
                self.open_group = None;
                if let Some(entry) = self.undo.pop() {
                    self.current = entry.before.clone();
                    focus = entry.meta.before.clone();
                    self.redo.push(entry);
                    self.history_revision += 1;
                }
            }
            Command::Redo | Command::GuardedRedo { .. } => {
                self.open_group = None;
                if let Some(entry) = self.redo.pop() {
                    self.current = entry.after.clone();
                    focus = entry.meta.after.clone();
                    self.undo.push(entry);
                    self.history_revision += 1;
                }
            }
            Command::EndGroup => self.open_group = None,
            Command::MarkSaved { state_id } => {
                if !self.known_states.contains(&state_id) {
                    return Err(CoreError::new(
                        "unknownState",
                        "Only a state produced by this project can be marked saved",
                    ));
                }
                self.saved_state_id = Some(state_id);
                self.open_group = None;
            }
            Command::CreateProject { .. } | Command::CloseProject => unreachable!(),
            command => {
                // Mutations happen on an isolated snapshot; failed validation leaves
                // the document, redo stack, grouping and state counter untouched.
                let mut next = before.clone();
                apply(&mut next, command)?;
                next.validate()?;
                if next != before {
                    let state_id = format!("{}:{}", next.id, self.next_state);
                    self.next_state += 1;
                    next.state_id = state_id.clone();
                    self.known_states.insert(state_id);
                    let meta = history.unwrap_or(HistoryMeta {
                        group_id: None,
                        label: "编辑".into(),
                        origin: None,
                        before: None,
                        after: None,
                    });
                    let merging = meta.group_id.is_some()
                        && self.open_group == meta.group_id
                        && self.redo.is_empty()
                        && self.undo.last().is_some_and(|entry| {
                            entry.meta.group_id == meta.group_id
                                && entry
                                    .meta
                                    .origin
                                    .as_ref()
                                    .map(|origin| (&origin.kind, &origin.plugin_id))
                                    == meta
                                        .origin
                                        .as_ref()
                                        .map(|origin| (&origin.kind, &origin.plugin_id))
                        });
                    if merging {
                        let last = self.undo.last_mut().unwrap();
                        last.after = next.clone();
                        last.meta.after = meta.after.clone();
                    } else {
                        self.undo.push(HistoryEntry {
                            entry_id: format!("{}:history:{}", next.id, self.next_entry),
                            before: before.clone(),
                            after: next.clone(),
                            meta: meta.clone(),
                        });
                        self.next_entry += 1;
                    }
                    self.open_group = meta.group_id;
                    self.redo.clear();
                    self.current = next;
                    self.history_revision += 1;
                }
            }
        }
        Ok(self.patch(Some(&before), focus))
    }
}

fn apply(snapshot: &mut Snapshot, command: Command) -> Result<(), CoreError> {
    match command {
        Command::Batch {
            commands,
            expected_state_id,
        } => {
            if expected_state_id
                .as_ref()
                .is_some_and(|id| id != &snapshot.state_id)
            {
                return Err(CoreError::new(
                    "stateConflict",
                    "The project changed since the proposal was captured",
                ));
            }
            for command in commands {
                if matches!(command, Command::Batch { .. }) {
                    return Err(CoreError::new(
                        "invalidBatchCommand",
                        "Nested batches are not supported",
                    ));
                }
                apply(snapshot, command)?;
                snapshot.validate()?;
            }
        }
        Command::UpdateProject {
            name,
            source_language,
            target_language,
        } => {
            if let Some(value) = name {
                snapshot.name = value;
            }
            if let Some(value) = source_language {
                snapshot.source_language = value;
            }
            if let Some(value) = target_language {
                snapshot.target_language = value;
            }
        }
        Command::AddImages { images } => {
            for image in images {
                if snapshot.images.contains_key(&image.id) {
                    return Err(
                        CoreError::new("duplicateId", "Image ID is already present").at(&image.id)
                    );
                }
                snapshot.order.push(image.id.clone());
                snapshot.images.insert(image.id.clone(), Arc::new(image));
            }
        }
        Command::UpdateImage {
            image_id,
            filename,
            asset_id,
            width,
            height,
            checksum,
        } => {
            let image = snapshot.image_mut(&image_id)?;
            if let Some(value) = filename {
                image.filename = value;
            }
            if let Some(value) = asset_id {
                image.asset_id = value;
            }
            if let Some(value) = width {
                image.width = value;
            }
            if let Some(value) = height {
                image.height = value;
            }
            if let Some(value) = checksum {
                image.checksum = Some(value);
            }
        }
        Command::RemoveImage { image_id } => {
            if snapshot.images.remove(&image_id).is_none() {
                return Err(
                    CoreError::new("imageNotFound", "The image does not exist").at(&image_id)
                );
            }
            snapshot.order.retain(|id| id != &image_id);
        }
        Command::ReorderImages { image_ids } => {
            validate_order(&snapshot.order, &image_ids)?;
            snapshot.order = image_ids;
        }
        Command::AddMarker { image_id, marker } => {
            snapshot.image_mut(&image_id)?.markers.push(marker)
        }
        Command::RemoveMarker {
            image_id,
            marker_id,
        } => {
            let image = snapshot.image_mut(&image_id)?;
            let index = image
                .markers
                .iter()
                .position(|m| m.id == marker_id)
                .ok_or_else(|| {
                    CoreError::new("markerNotFound", "The marker does not exist").at(&marker_id)
                })?;
            image.markers.remove(index);
        }
        Command::UpdateMarker {
            image_id,
            marker_id,
            geometry,
            translation,
            style,
        } => {
            let marker = snapshot
                .image_mut(&image_id)?
                .markers
                .iter_mut()
                .find(|m| m.id == marker_id)
                .ok_or_else(|| {
                    CoreError::new("markerNotFound", "The marker does not exist").at(&marker_id)
                })?;
            if let Some(value) = geometry {
                marker.geometry = value;
            }
            if let Some(value) = translation {
                marker.translation = value;
            }
            if let Some(value) = style {
                marker.style = value;
            }
        }
        Command::UpdateAssistance { updates } => {
            let mut targets = HashSet::new();
            for update in updates {
                if !targets.insert((update.image_id.clone(), update.marker_id.clone())) {
                    return Err(CoreError::new(
                        "duplicateAssistanceUpdate",
                        "Each marker may only occur once in an assistance update",
                    )
                    .at(&update.marker_id));
                }
                if let Some(expected) = &update.expected {
                    if expected
                        .source_language
                        .as_ref()
                        .is_some_and(|language| language != &snapshot.source_language)
                        || expected
                            .target_language
                            .as_ref()
                            .is_some_and(|language| language != &snapshot.target_language)
                    {
                        return Err(CoreError::new(
                            "assistanceConflict",
                            "Project languages changed while the assistance task was running",
                        )
                        .at(&update.marker_id));
                    }
                }
                let image = snapshot.image_mut(&update.image_id)?;
                if update
                    .expected
                    .as_ref()
                    .and_then(|expected| expected.asset_id.as_ref())
                    .is_some_and(|asset| asset != &image.asset_id)
                {
                    return Err(CoreError::new(
                        "assistanceConflict",
                        "The image changed while the assistance task was running",
                    )
                    .at(&update.marker_id));
                }
                let marker = image
                    .markers
                    .iter_mut()
                    .find(|marker| marker.id == update.marker_id)
                    .ok_or_else(|| {
                        CoreError::new("markerNotFound", "The marker does not exist")
                            .at(&update.marker_id)
                    })?;
                if let Some(expected) = &update.expected {
                    let cached_matches = |key: &str, expected: &Option<String>| {
                        let actual = marker.bunny_cache.as_ref().and_then(|cache| cache.get(key));
                        match (expected, actual) {
                            (None, None | Some(serde_json::Value::Null)) => true,
                            (Some(expected), Some(serde_json::Value::String(actual))) => {
                                expected == actual
                            }
                            _ => false,
                        }
                    };
                    if expected
                        .geometry
                        .as_ref()
                        .is_some_and(|geometry| geometry != &marker.geometry)
                        || expected
                            .original_text
                            .as_ref()
                            .is_some_and(|text| !cached_matches("originalText", text))
                        || expected
                            .machine_translation
                            .as_ref()
                            .is_some_and(|text| !cached_matches("machineTranslation", text))
                    {
                        return Err(CoreError::new(
                            "assistanceConflict",
                            "The marker changed while the assistance task was running",
                        )
                        .at(&update.marker_id));
                    }
                }
                let changes = [
                    ("originalText", update.original_text),
                    ("machineTranslation", update.machine_translation),
                    ("lastOcrModel", update.last_ocr_model),
                    ("lastTranslationService", update.last_translation_service),
                ];
                if !changes.iter().any(|(_, value)| value.is_some()) {
                    continue;
                }
                let mut cache = match &marker.bunny_cache {
                    None | Some(serde_json::Value::Null) => serde_json::Map::new(),
                    Some(serde_json::Value::Object(cache)) => cache.clone(),
                    _ => return Err(CoreError::new("invalidAssistanceCache", "Assistance fields require an object cache; the existing value was preserved").at(&update.marker_id)),
                };
                for (key, change) in changes {
                    match change {
                        Some(Some(value)) => {
                            cache.insert(key.into(), serde_json::Value::String(value));
                        }
                        Some(None) => {
                            cache.remove(key);
                        }
                        None => (),
                    }
                }
                if !cache.is_empty() || marker.bunny_cache.is_some() {
                    marker.bunny_cache = Some(serde_json::Value::Object(cache));
                }
            }
        }
        Command::ReorderMarkers {
            image_id,
            marker_ids,
        } => {
            let image = snapshot.image_mut(&image_id)?;
            validate_order(
                &image
                    .markers
                    .iter()
                    .map(|m| m.id.clone())
                    .collect::<Vec<_>>(),
                &marker_ids,
            )?;
            let mut markers: HashMap<_, _> = std::mem::take(&mut image.markers)
                .into_iter()
                .map(|m| (m.id.clone(), m))
                .collect();
            image.markers = marker_ids
                .into_iter()
                .map(|id| markers.remove(&id).unwrap())
                .collect();
        }
        _ => {
            return Err(CoreError::new(
                "invalidBatchCommand",
                "Only document mutations can appear in a batch",
            ))
        }
    }
    Ok(())
}

fn validate_order(current: &[String], requested: &[String]) -> Result<(), CoreError> {
    let old: HashSet<_> = current.iter().collect();
    let new: HashSet<_> = requested.iter().collect();
    if current.len() != requested.len() || new.len() != requested.len() || old != new {
        Err(CoreError::new(
            "invalidOrder",
            "A reorder must contain every existing ID exactly once",
        ))
    } else {
        Ok(())
    }
}

/// A single serial owner is used by both the desktop host and web worker.
#[derive(Default)]
pub struct Engine {
    projects: HashMap<String, Project>,
    replies: HashMap<(String, String), Reply>,
    revision: u64,
}

impl Engine {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn document(&self, project_id: &str) -> Result<ProjectDocument, CoreError> {
        self.projects
            .get(project_id)
            .map(|p| p.current.document())
            .ok_or_else(|| {
                CoreError::new("projectNotFound", "The project is not open").at(project_id)
            })
    }

    /// Validate a proposal against the committed snapshot without touching state,
    /// history, grouping or the idempotent acknowledgement cache.
    pub fn preview(
        &self,
        project_id: &str,
        commands: Vec<Command>,
        expected_state_id: Option<String>,
    ) -> Result<ProjectDocument, CoreError> {
        let project = self.projects.get(project_id).ok_or_else(|| {
            CoreError::new("projectNotFound", "The project is not open").at(project_id)
        })?;
        let mut proposed = project.current.clone();
        apply(
            &mut proposed,
            Command::Batch {
                commands,
                expected_state_id,
            },
        )?;
        proposed.validate()?;
        Ok(proposed.document())
    }

    /// Both stacks are returned top-first; snapshots remain private to the core.
    pub fn history(&self, project_id: &str, query: HistoryQuery) -> Result<HistoryPage, CoreError> {
        let project = self.projects.get(project_id).ok_or_else(|| {
            CoreError::new("projectNotFound", "The project is not open").at(project_id)
        })?;
        let offset = query.offset.unwrap_or(0) as usize;
        let limit = query.limit.unwrap_or(100).min(1000) as usize;
        let page = |stack: &[HistoryEntry]| {
            stack
                .iter()
                .rev()
                .skip(offset)
                .take(limit)
                .map(|entry| HistoryEntryInfo {
                    entry_id: entry.entry_id.clone(),
                    label: entry.meta.label.clone(),
                    origin: entry.meta.origin.clone(),
                    before_state_id: entry.before.state_id.clone(),
                    after_state_id: entry.after.state_id.clone(),
                })
                .collect()
        };
        Ok(HistoryPage {
            undo: page(&project.undo),
            redo: page(&project.redo),
            undo_total: project.undo.len() as u32,
            redo_total: project.redo.len() as u32,
            history_revision: project.history_revision,
        })
    }

    pub fn dispatch(&mut self, envelope: Envelope) -> Reply {
        let key = (envelope.session_id.clone(), envelope.command_id.clone());
        if let Some(reply) = self.replies.get(&key) {
            return reply.clone();
        }
        self.revision += 1;
        let mut reply = Reply {
            command_id: envelope.command_id.clone(),
            event_revision: self.revision,
            project_id: envelope.project_id.clone(),
            patch: None,
            closed_project_id: None,
            error: None,
        };
        if envelope.command_id.trim().is_empty() || envelope.session_id.trim().is_empty() {
            reply.error = Some(CoreError::new(
                "invalidEnvelope",
                "Command ID and session ID are required",
            ));
        } else {
            match self.execute(envelope, &mut reply) {
                Ok(()) => {}
                Err(error) => reply.error = Some(error),
            }
        }
        self.replies.insert(key, reply.clone());
        reply
    }

    fn execute(&mut self, envelope: Envelope, reply: &mut Reply) -> Result<(), CoreError> {
        if let Command::CreateProject { document, saved } = envelope.command {
            validate_document(&document)?;
            if self.projects.contains_key(&document.id) {
                return Err(CoreError::new(
                    "projectAlreadyOpen",
                    "A project with this ID is already open",
                )
                .at(&document.id));
            }
            let id = document.id.clone();
            let state_id = format!("{id}:0");
            let project = Project {
                current: Snapshot::new(document, state_id.clone()),
                saved_state_id: saved.then_some(state_id.clone()),
                known_states: HashSet::from([state_id]),
                undo: Vec::new(),
                redo: Vec::new(),
                open_group: None,
                next_state: 1,
                next_entry: 1,
                history_revision: 0,
            };
            reply.project_id = Some(id.clone());
            reply.patch = Some(project.patch(None, None));
            self.projects.insert(id, project);
            return Ok(());
        }
        let id = envelope
            .project_id
            .ok_or_else(|| CoreError::new("projectRequired", "This command needs a project ID"))?;
        if matches!(envelope.command, Command::CloseProject) {
            self.projects.remove(&id).ok_or_else(|| {
                CoreError::new("projectNotFound", "The project is not open").at(&id)
            })?;
            reply.closed_project_id = Some(id);
        } else {
            let project = self.projects.get_mut(&id).ok_or_else(|| {
                CoreError::new("projectNotFound", "The project is not open").at(&id)
            })?;
            if !matches!(
                envelope.command,
                Command::Undo
                    | Command::Redo
                    | Command::GuardedUndo { .. }
                    | Command::GuardedRedo { .. }
                    | Command::EndGroup
                    | Command::MarkSaved { .. }
            ) && envelope
                .expected_state_id
                .as_ref()
                .is_some_and(|state_id| state_id != &project.current.state_id)
            {
                return Err(CoreError::new(
                    "stateConflict",
                    "The project changed since the proposal was captured",
                ));
            }
            reply.patch = Some(project.execute(envelope.command, envelope.history)?);
        }
        Ok(())
    }
}

import { writable } from 'svelte/store';
import { platformService } from './platformService';

export interface UpdateInfo {
  available: boolean;
  version?: string;
  currentVersion: string;
  notes?: string;
  date?: string;
  error?: string;
  pendingInstall?: boolean;
}

export type UpdateSource = 'gitee' | 'github';

export interface UpdateSettings {
  autoCheck: boolean;
  autoDownload: boolean;
  checkInterval: number; // in hours
  lastCheck?: string;
  updateSource: UpdateSource;
}

export const UPDATE_SOURCE_NAMES: Record<UpdateSource, string> = {
  gitee: 'Gitee (国内)',
  github: 'GitHub (国际)'
};

const defaultSettings: UpdateSettings = {
  autoCheck: true,
  autoDownload: true,
  checkInterval: 24,
  lastCheck: undefined,
  updateSource: 'gitee'
};

// Note: Update sources are configured in tauri.conf.json
// The updateSource setting is stored for UI display and future use
// Currently Tauri will try all configured endpoints in order

// Stores
export const updateInfo = writable<UpdateInfo>({
  available: false,
  currentVersion: '0.1.0',
  pendingInstall: false
});

export const updateSettings = writable<UpdateSettings>(defaultSettings);
export const isCheckingUpdate = writable<boolean>(false);
export const isDownloadingUpdate = writable<boolean>(false);
export const downloadProgress = writable<number>(0);

class UpdaterService {
  private checkInterval: NodeJS.Timeout | null = null;
  
  constructor() {
    this.loadSettings();
    this.checkPendingUpdate();
    this.initAutoCheck();
  }
  
  private checkPendingUpdate() {
    if (!platformService.isTauri()) return;
    
    // Check if there's a pending update from previous session
    const hasPendingUpdate = localStorage.getItem('pendingUpdate') === 'true';
    if (hasPendingUpdate) {
      updateInfo.update(info => ({ ...info, pendingInstall: true }));
    }
  }
  
  private async loadSettings() {
    if (!platformService.isTauri()) return;
    
    try {
      const stored = localStorage.getItem('updateSettings');
      if (stored) {
        const settings = JSON.parse(stored);
        // Validate settings structure
        const validatedSettings = this.validateSettings(settings);
        updateSettings.set(validatedSettings);
      } else {
        // No settings found, use defaults
        updateSettings.set(defaultSettings);
        this.saveSettings(defaultSettings);
      }
    } catch (error) {
      console.error('Failed to load update settings, using defaults:', error);
      // If parse fails or settings are corrupted, use defaults
      updateSettings.set(defaultSettings);
      this.saveSettings(defaultSettings);
    }
  }
  
  private validateSettings(settings: any): UpdateSettings {
    // Ensure all required fields exist with proper types
    const validated: UpdateSettings = {
      autoCheck: typeof settings.autoCheck === 'boolean' ? settings.autoCheck : defaultSettings.autoCheck,
      autoDownload: typeof settings.autoDownload === 'boolean' ? settings.autoDownload : defaultSettings.autoDownload,
      checkInterval: typeof settings.checkInterval === 'number' ? settings.checkInterval : defaultSettings.checkInterval,
      lastCheck: typeof settings.lastCheck === 'string' ? settings.lastCheck : undefined,
      updateSource: (settings.updateSource === 'gitee' || settings.updateSource === 'github') ? settings.updateSource : defaultSettings.updateSource
    };
    return validated;
  }
  
  private saveSettings(settings: UpdateSettings) {
    if (!platformService.isTauri()) return;
    
    try {
      localStorage.setItem('updateSettings', JSON.stringify(settings));
    } catch (error) {
      console.error('Failed to save update settings:', error);
    }
  }
  
  private async initAutoCheck() {
    if (!platformService.isTauri()) return;
    
    updateSettings.subscribe(settings => {
      this.saveSettings(settings);
      
      // Clear existing interval
      if (this.checkInterval) {
        clearInterval(this.checkInterval);
        this.checkInterval = null;
      }
      
      // Set up new interval if auto-check is enabled
      if (settings.autoCheck) {
        // Check on startup if needed
        const lastCheck = settings.lastCheck ? new Date(settings.lastCheck) : null;
        const now = new Date();
        const hoursSinceLastCheck = lastCheck 
          ? (now.getTime() - lastCheck.getTime()) / (1000 * 60 * 60)
          : Infinity;
        
        if (hoursSinceLastCheck >= settings.checkInterval) {
          this.checkForUpdates();
        }
        
        // Set up periodic check
        this.checkInterval = setInterval(
          () => this.checkForUpdates(),
          settings.checkInterval * 60 * 60 * 1000
        );
      }
    });
  }
  
  async checkForUpdates(silent = false): Promise<UpdateInfo> {
    if (!platformService.isTauri()) {
      return {
        available: false,
        currentVersion: '0.1.0',
        error: 'Updates are only available in the desktop app'
      };
    }
    
    if (!silent) {
      isCheckingUpdate.set(true);
    }
    
    try {
      // Get current update source
      const settings = await this.getSettings();
      const source = settings.updateSource;
      
      // Use backend command to check updates with specific source
      const [coreModule, appModule] = await Promise.all([
        import('@tauri-apps/api/core'),
        import('@tauri-apps/api/app')
      ]);
      const invoke = coreModule.invoke;
      const getVersion = appModule.getVersion;
      
      const currentVersion = await getVersion();
      
      // Call backend to check updates with selected source
      const updateData = await invoke<any>('check_for_updates_with_source', { source });
      
      const info: UpdateInfo = {
        available: updateData.available || false,
        currentVersion,
        version: updateData.version,
        notes: updateData.notes,
        date: updateData.date
      };
      
      updateInfo.set(info);
      
      // Update last check time
      updateSettings.update(settings => ({
        ...settings,
        lastCheck: new Date().toISOString()
      }));
      
      // Auto-download if enabled and update is available
      if (info.available) {
        const settings = await this.getSettings();
        if (settings.autoDownload) {
          await this.downloadAndInstall();
        }
      }
      
      return info;
    } catch (error) {
      console.error('Failed to check for updates:', error);
      const errorInfo: UpdateInfo = {
        available: false,
        currentVersion: '0.1.0',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
      updateInfo.set(errorInfo);
      return errorInfo;
    } finally {
      if (!silent) {
        isCheckingUpdate.set(false);
      }
    }
  }
  
  async downloadAndInstall(restartNow = false): Promise<void> {
    if (!platformService.isTauri()) return;
    
    isDownloadingUpdate.set(true);
    downloadProgress.set(0);
    
    try {
      // Get current update source
      const settings = await this.getSettings();
      const source = settings.updateSource;
      
      // Use backend command to download and install with specific source
      const [coreModule, processModule] = await Promise.all([
        import('@tauri-apps/api/core'),
        import('@tauri-apps/plugin-process')
      ]);
      const invoke = coreModule.invoke;
      const relaunch = processModule.relaunch;
      
      // Call backend to download and install update with selected source
      await invoke('download_and_install_update', { source });
      
      // Mark update as pending install
      updateInfo.update(info => ({ ...info, pendingInstall: true }));
      localStorage.setItem('pendingUpdate', 'true');
      
      // Only relaunch if explicitly requested
      if (restartNow) {
        await relaunch();
      }
    } catch (error) {
      console.error('Failed to download and install update:', error);
      throw error;
    } finally {
      isDownloadingUpdate.set(false);
      downloadProgress.set(0);
    }
  }
  
  async restartAndUpdate(): Promise<void> {
    if (!platformService.isTauri()) return;
    
    try {
      const processModule = await import('@tauri-apps/plugin-process');
      const relaunch = processModule.relaunch;
      await relaunch();
    } catch (error) {
      console.error('Failed to restart app:', error);
      throw error;
    }
  }
  
  async getSettings(): Promise<UpdateSettings> {
    return new Promise(resolve => {
      let unsubscribe: (() => void) | null = null;
      unsubscribe = updateSettings.subscribe(settings => {
        if (unsubscribe) {
          unsubscribe();
        }
        resolve(settings);
      });
    });
  }
  
  async updateSetting(key: keyof UpdateSettings, value: any) {
    updateSettings.update(settings => ({
      ...settings,
      [key]: value
    }));
  }
}

export const updaterService = new UpdaterService();
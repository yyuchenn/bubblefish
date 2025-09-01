import { writable } from 'svelte/store';
import { platformService } from './platformService';

export interface UpdateInfo {
  available: boolean;
  version?: string;
  currentVersion: string;
  notes?: string;
  date?: string;
  error?: string;
}

export interface UpdateSettings {
  autoCheck: boolean;
  autoDownload: boolean;
  checkInterval: number; // in hours
  lastCheck?: string;
}

const defaultSettings: UpdateSettings = {
  autoCheck: true,
  autoDownload: false,
  checkInterval: 24,
  lastCheck: undefined
};

// Stores
export const updateInfo = writable<UpdateInfo>({
  available: false,
  currentVersion: '0.1.0'
});

export const updateSettings = writable<UpdateSettings>(defaultSettings);
export const isCheckingUpdate = writable<boolean>(false);
export const isDownloadingUpdate = writable<boolean>(false);
export const downloadProgress = writable<number>(0);

class UpdaterService {
  private checkInterval: NodeJS.Timeout | null = null;
  
  constructor() {
    this.loadSettings();
    this.initAutoCheck();
  }
  
  private async loadSettings() {
    if (!platformService.isTauri()) return;
    
    try {
      const stored = localStorage.getItem('updateSettings');
      if (stored) {
        const settings = JSON.parse(stored);
        updateSettings.set({ ...defaultSettings, ...settings });
      }
    } catch (error) {
      console.error('Failed to load update settings:', error);
    }
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
      // Only try to import if we're in Tauri environment
      if (!platformService.isTauri()) {
        throw new Error('Update service not available in web environment');
      }
      
      // Dynamic imports for Tauri modules (using string concatenation to avoid Vite static analysis)
      const [updaterModule, appModule] = await Promise.all([
        import(/* @vite-ignore */ '@tauri-apps/plugin-updater'),
        import(/* @vite-ignore */ '@tauri-apps/api/app')
      ]);
      const check = updaterModule.check;
      const getVersion = appModule.getVersion;
      
      const currentVersion = await getVersion();
      const update = await check();
      
      const info: UpdateInfo = {
        available: update?.available || false,
        currentVersion,
        version: update?.version,
        notes: update?.body,
        date: update?.date
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
  
  async downloadAndInstall(): Promise<void> {
    if (!platformService.isTauri()) return;
    
    isDownloadingUpdate.set(true);
    downloadProgress.set(0);
    
    try {
      // Only try to import if we're in Tauri environment
      if (!platformService.isTauri()) {
        throw new Error('Update service not available in web environment');
      }
      
      // Dynamic imports for Tauri modules (using string concatenation to avoid Vite static analysis)
      const [updaterModule, processModule] = await Promise.all([
        import(/* @vite-ignore */ '@tauri-apps/plugin-updater'),
        import(/* @vite-ignore */ '@tauri-apps/plugin-process')
      ]);
      const check = updaterModule.check;
      const relaunch = processModule.relaunch;
      
      const update = await check();
      if (!update?.available) {
        throw new Error('No update available');
      }
      
      // Download and install
      let downloaded = 0;
      let contentLength = 0;
      
      await update.downloadAndInstall((event: any) => {
        switch (event.event) {
          case 'Started':
            contentLength = event.data.contentLength || 0;
            console.log(`Started downloading update: ${contentLength} bytes`);
            break;
          case 'Progress':
            downloaded += event.data.chunkLength;
            if (contentLength > 0) {
              const progress = (downloaded / contentLength) * 100;
              downloadProgress.set(progress);
            }
            break;
          case 'Finished':
            downloadProgress.set(100);
            console.log('Update downloaded successfully');
            break;
        }
      });
      
      // Relaunch the app
      await relaunch();
    } catch (error) {
      console.error('Failed to download and install update:', error);
      throw error;
    } finally {
      isDownloadingUpdate.set(false);
      downloadProgress.set(0);
    }
  }
  
  async getSettings(): Promise<UpdateSettings> {
    return new Promise(resolve => {
      const unsubscribe = updateSettings.subscribe(settings => {
        unsubscribe();
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
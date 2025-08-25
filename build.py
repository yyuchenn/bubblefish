#!/usr/bin/env python3
"""
Bubblefish Development Build Script
Cross-platform build automation for the Bubblefish project

Usage: python build.py <command> [options]
Run `python build.py help` to see all available commands
"""

import os
import sys
import subprocess
import shutil
import time
import argparse
import signal
from pathlib import Path

# Colors for cross-platform terminal output
class Colors:
    RESET = '\033[0m'
    BOLD = '\033[1m'
    RED = '\033[91m'
    GREEN = '\033[92m'
    YELLOW = '\033[93m'
    BLUE = '\033[94m'
    MAGENTA = '\033[95m'
    CYAN = '\033[96m'
    WHITE = '\033[97m'

def colorize(text: str, color: str) -> str:
    """Add color to text if terminal supports it"""
    if os.getenv('NO_COLOR') or not sys.stdout.isatty():
        return text
    return f"{color}{text}{Colors.RESET}"

def log_info(message: str):
    """Print info message with emoji and color"""
    print(colorize(f"ℹ️  {message}", Colors.BLUE))

def log_success(message: str):
    """Print success message with emoji and color"""
    print(colorize(f"✅ {message}", Colors.GREEN))

def log_warning(message: str):
    """Print warning message with emoji and color"""
    print(colorize(f"⚠️  {message}", Colors.YELLOW))

def log_error(message: str):
    """Print error message with emoji and color"""
    print(colorize(f"❌ {message}", Colors.RED))

def log_step(message: str):
    """Print step message with emoji and color"""
    print(colorize(f"🔄 {message}", Colors.CYAN))

def is_windows() -> bool:
    import platform
    return platform.system().lower() == "windows"

class BuildScript:
    def __init__(self):
        self.root_dir = Path(__file__).parent.absolute()
        self.frontend_dir = self.root_dir / "frontend"
        self.desktop_dir = self.root_dir / "desktop"
        self.core_dir = self.root_dir / "core"
        
        # 统一的构建输出目录
        self.build_dir = self.root_dir / "target" / "build"
        self.wasm_output_dir = self.build_dir / "wasm"
        self.frontend_output_dir = self.build_dir / "frontend"
        self.desktop_output_dir = self.build_dir / "desktop"
        
        # 确保构建目录存在
        self.build_dir.mkdir(parents=True, exist_ok=True)
        self.wasm_output_dir.mkdir(parents=True, exist_ok=True)
        self.frontend_output_dir.mkdir(parents=True, exist_ok=True)
        self.desktop_output_dir.mkdir(parents=True, exist_ok=True)
        
    def run_command(self, command: list[str], cwd: Path = None) -> bool:
        """Run a command and return whether it succeeded"""
        cmd_str = " ".join(command)
        working_dir = cwd or self.root_dir
        log_info(f"Running: {cmd_str}")
        log_info(f"Working directory: {working_dir}")
        
        # Use shell=True on Windows to find .cmd/.bat files
        shell_flag = is_windows()
        result = subprocess.run(command, cwd=working_dir, shell=shell_flag)
        
        if result.returncode == 0:
            log_success(f"Command succeeded: {cmd_str}")
            return True
        else:
            log_error(f"Command failed with exit code {result.returncode}: {cmd_str}")
            return False

    def run_command_with_env(self, command: list[str], cwd: Path = None, env: dict = None) -> bool:
        """Run a command with custom environment variables and return whether it succeeded"""
        cmd_str = " ".join(command)
        working_dir = cwd or self.root_dir
        log_info(f"Running: {cmd_str}")
        log_info(f"Working directory: {working_dir}")
        if env:
            log_info(f"Custom environment: {' '.join([f'{k}={v}' for k, v in env.items() if k.startswith('RUST')])}")
        
        # Use shell=True on Windows to find .cmd/.bat files
        shell_flag = is_windows()
        result = subprocess.run(command, cwd=working_dir, shell=shell_flag, env=env)
        
        if result.returncode == 0:
            log_success(f"Command succeeded: {cmd_str}")
            return True
        else:
            log_error(f"Command failed with exit code {result.returncode}: {cmd_str}")
            return False
    
    def clean_build_dir(self) -> bool:
        """Clean the unified build directory"""
        log_info("Cleaning unified build directory...")
        
        if self.build_dir.exists():
            try:
                shutil.rmtree(self.build_dir)
                log_success(f"Cleaned: {self.build_dir}")
            except Exception as e:
                log_error(f"Failed to clean build directory: {e}")
                return False
        
        # Recreate the structure
        return self.create_build_dirs()
    
    def create_build_dirs(self) -> bool:
        """Create the unified build directory structure"""
        try:
            (self.build_dir / "wasm").mkdir(parents=True, exist_ok=True)
            (self.build_dir / "frontend").mkdir(parents=True, exist_ok=True)
            (self.build_dir / "desktop").mkdir(parents=True, exist_ok=True)
            log_info(f"Created build directory structure: {self.build_dir}")
            return True
        except Exception as e:
            log_error(f"Failed to create build directories: {e}")
            return False
    
    def validate_build_artifacts(self) -> bool:
        """Validate that build artifacts exist in the unified build directory"""
        log_info("Validating build artifacts...")
        
        artifacts = {
            "WASM package": self.build_dir / "wasm" / "pkg",
            "Frontend build": self.build_dir / "frontend",
            "Desktop build": self.build_dir / "desktop"
        }
        
        all_valid = True
        for name, path in artifacts.items():
            if path.exists():
                log_success(f"✓ {name}: {path}")
            else:
                log_warning(f"✗ {name}: {path} (not found)")
                all_valid = False
        
        return all_valid

    def check_tools(self) -> bool:
        """Check if all required tools are available"""
        log_info("Checking required tools...")
        
        tools = [
            ("node", ["node", "--version"]),
            ("yarn", ["yarn", "--version"]),
            ("rustc", ["rustc", "--version"]),
            ("cargo", ["cargo", "--version"]),
            ("wasm-pack", ["wasm-pack", "--version"])
        ]
        
        all_ok = True
        for tool_name, cmd in tools:
            try:
                shell_flag = is_windows()
                subprocess.run(cmd, capture_output=True, check=True,
                               encoding='utf-8', errors='ignore', shell=shell_flag)
                log_success(f"{tool_name} is available")
            except (subprocess.CalledProcessError, FileNotFoundError):
                log_error(f"{tool_name} not found")
                all_ok = False
        
        return all_ok

    def install_tauri_cli(self) -> bool:
        """Install Tauri CLI if not present"""
        try:
            # Check if already installed
            shell_flag = is_windows()
            result = subprocess.run(["cargo", "tauri", "--version"],
                                  capture_output=True, check=True,
                                  encoding='utf-8', errors='ignore', shell=shell_flag)
            log_success(f"Tauri CLI already installed ({result.stdout.strip()})")
            return True
        except (subprocess.CalledProcessError, FileNotFoundError):
            log_info("Installing Tauri CLI...")
            return self.run_command(["cargo", "install", "tauri-cli"])

    def install_cargo_tools(self) -> bool:
        """Install additional cargo tools needed for development"""
        tools = [
            ("cargo-watch", "File watching and auto-rebuilding"),
            ("wasm-pack", "WASM packaging tool")
        ]
        
        for tool_name, description in tools:
            try:
                shell_flag = is_windows()
                # Check if tool is already installed
                result = subprocess.run([tool_name, "--version"],
                                      capture_output=True, check=True,
                                      encoding='utf-8', errors='ignore', shell=shell_flag)
                log_success(f"{tool_name} already installed")
            except (subprocess.CalledProcessError, FileNotFoundError):
                log_info(f"Installing {tool_name} ({description})...")
                if not self.run_command(["cargo", "install", tool_name]):
                    log_warning(f"Failed to install {tool_name}, but continuing...")
        
        return True

    def check_rust_deps(self) -> bool:
        """Check and fetch Rust dependencies"""
        log_info("Checking Rust dependencies...")
        
        # Check dependencies for each Rust workspace
        rust_projects = [
            (self.root_dir, "workspace"),
            (self.core_dir, "core"),
            (self.desktop_dir, "desktop")
        ]
        
        for project_dir, project_name in rust_projects:
            if (project_dir / "Cargo.toml").exists():
                log_info(f"Checking dependencies for {project_name}...")
                if not self.run_command(["cargo", "check"], cwd=project_dir):
                    log_warning(f"Dependency check failed for {project_name}, but continuing...")
        
        return True

    def frontend_install_deps(self, force: bool = False) -> bool:
        """Install frontend dependencies if needed"""
        node_modules = self.frontend_dir / "node_modules"
        if not node_modules.exists() or force:
            log_info("Installing frontend dependencies...")
            return self.run_command(["yarn", "install"], cwd=self.frontend_dir)
        else:
            log_success("Frontend dependencies already installed")
            return True

    def check_nightly_toolchain(self) -> bool:
        """Check if nightly Rust toolchain is installed"""
        try:
            shell_flag = is_windows()
            result = subprocess.run(
                ["rustup", "toolchain", "list"],
                capture_output=True, check=True,
                encoding='utf-8', errors='ignore', shell=shell_flag
            )
            # Check if any nightly toolchain is installed
            for line in result.stdout.split('\n'):
                if 'nightly' in line:
                    log_success("Nightly Rust toolchain is available")
                    return True
            return False
        except (subprocess.CalledProcessError, FileNotFoundError):
            return False

    def install_nightly_toolchain(self) -> bool:
        """Install nightly Rust toolchain for wasm-bindgen-rayon"""
        log_info("Installing nightly Rust toolchain...")
        
        # Install a specific nightly version that's known to work with wasm-bindgen-rayon
        nightly_version = "nightly-2024-08-02"
        
        commands = [
            ["rustup", "toolchain", "install", nightly_version],
            ["rustup", "component", "add", "rust-src", "--toolchain", nightly_version]
        ]
        
        for cmd in commands:
            if not self.run_command(cmd):
                log_error(f"Failed to install nightly toolchain component: {' '.join(cmd)}")
                return False
        
        log_success("Nightly Rust toolchain installed successfully")
        return True

    # ===== Web Development Commands =====
    
    def wasm_build(self, dev: bool = False) -> bool:
        """Build WASM module with wasm-bindgen-rayon support"""
        mode = "development" if dev else "production"
        log_info(f"Building WASM with multithreading support ({mode})...")
        
        # 检查是否安装了nightly toolchain
        if not self.check_nightly_toolchain():
            log_warning("Installing nightly Rust toolchain for wasm-bindgen-rayon...")
            if not self.install_nightly_toolchain():
                return False
        
        cmd = ["wasm-pack", "build", "--target", "web", "--out-dir", "pkg"]
        
        if dev:
            cmd.append("--dev")
            # 在开发模式下确保启用debug assertions和WASM threads
            cmd.extend(["--", 
                       "--features", "wasm", 
                       "--profile", "dev",
                       "-Z", "build-std=panic_abort,std",
                       "--target", "wasm32-unknown-unknown"])
        else:
            # 生产模式需要的特殊标志
            cmd.extend(["--", 
                       "--features", "wasm",
                       "-Z", "build-std=panic_abort,std", 
                       "--target", "wasm32-unknown-unknown"])
        
        # 设置环境变量以启用WASM threads、SIMD和nightly工具链
        env = os.environ.copy()
        # 合并所有RUSTFLAGS设置
        # - target-feature: 启用原子操作、批量内存、可变全局变量和SIMD
        # - link-arg: 设置WASM内存配置（初始64MB，最大4GB）
        rustflags = "-C target-feature=+atomics,+bulk-memory,+mutable-globals,+simd128 -C link-arg=--initial-memory=67108864 -C link-arg=--max-memory=4294967296"
        
        # 在生产模式下添加优化级别
        if not dev:
            rustflags += " -C opt-level=3"
        
        env["RUSTFLAGS"] = rustflags
        env["RUSTUP_TOOLCHAIN"] = "nightly"
        
        if not self.run_command_with_env(cmd, cwd=self.core_dir, env=env):
            return False
        
        # 复制 WASM 文件到统一构建目录和前端目录
        return self.copy_wasm_files()
    
    def copy_wasm_files(self) -> bool:
        """Copy WASM files to unified build directory and frontend lib folder"""
        log_info("Copying WASM files...")
        
        wasm_pkg_dir = self.core_dir / "pkg"
        
        try:
            # 1. 复制到统一构建目录，保持pkg子目录结构
            wasm_build_pkg_dir = self.wasm_output_dir / "pkg"
            if wasm_build_pkg_dir.exists():
                shutil.rmtree(wasm_build_pkg_dir)
            shutil.copytree(wasm_pkg_dir, wasm_build_pkg_dir)
            log_success(f"WASM package copied to {wasm_build_pkg_dir}")
            
            # 2. 复制到前端lib目录下的wasm-pkg文件夹（更清晰的命名）
            frontend_wasm_dir = self.frontend_dir / "src" / "lib" / "wasm-pkg"
            if frontend_wasm_dir.exists():
                shutil.rmtree(frontend_wasm_dir)
            frontend_wasm_dir.mkdir(parents=True, exist_ok=True)
            
            # 复制所有 WASM 相关文件到前端
            for file_pattern in ["*.wasm", "*.js", "*.d.ts", "package.json"]:
                import glob
                source_files = glob.glob(str(wasm_pkg_dir / file_pattern))
                for source_file in source_files:
                    source_path = Path(source_file)
                    dest_path = frontend_wasm_dir / source_path.name
                    shutil.copy2(source_path, dest_path)
                    log_info(f"Copied {source_path.name} to frontend lib")
            
            # 复制 snippets 目录（wasm-bindgen-rayon 需要）
            snippets_dir = wasm_pkg_dir / "snippets"
            if snippets_dir.exists():
                frontend_snippets_dir = frontend_wasm_dir / "snippets"
                if frontend_snippets_dir.exists():
                    shutil.rmtree(frontend_snippets_dir)
                shutil.copytree(snippets_dir, frontend_snippets_dir)
                log_info("Copied snippets directory for wasm-bindgen-rayon")
            
            return True
        except Exception as e:
            log_error(f"Failed to copy WASM files: {e}")
            return False

    def wasm_dev(self) -> bool:
        """Build WASM for development"""
        return self.wasm_build(dev=True)

    def frontend_dev(self) -> bool:
        """Start frontend development server with WASM threading support"""
        log_info("Starting frontend development server with WASM threading support...")
        if not self.frontend_install_deps():
            return False
        
        log_info("Note: Development server configured with Cross-Origin Isolation headers for WASM threading")
        return self.run_command(["yarn", "dev"], cwd=self.frontend_dir)

    def frontend_build(self) -> bool:
        """Build frontend for production"""
        log_info("Building frontend for production...")
        if not self.frontend_install_deps():
            return False
        
        # 构建前端
        if not self.run_command(["yarn", "build"], cwd=self.frontend_dir):
            return False
        
        # 复制构建产物到统一构建目录
        return self.copy_frontend_build()
    
    def copy_frontend_build(self) -> bool:
        """Copy frontend build output to unified build directory"""
        log_info("Copying frontend build to unified directory...")
        
        try:
            frontend_build_source = self.frontend_dir / "build"
            
            if not frontend_build_source.exists():
                log_warning("Frontend build directory not found, checking .svelte-kit/output")
                frontend_build_source = self.frontend_dir / ".svelte-kit" / "output"
            
            if not frontend_build_source.exists():
                log_error("Frontend build output not found")
                return False
            
            # 清理并复制
            if self.frontend_output_dir.exists():
                shutil.rmtree(self.frontend_output_dir)
            
            shutil.copytree(frontend_build_source, self.frontend_output_dir)
            log_success(f"Frontend build copied to {self.frontend_output_dir}")
            return True
            
        except Exception as e:
            log_error(f"Failed to copy frontend build: {e}")
            return False

    def web_dev(self) -> bool:
        """Start web development environment (WASM + Frontend)"""
        log_info("Starting web development environment...")
        
        # 自动构建 WASM
        log_info("Step 1/2: Building WASM module...")
        if not self.wasm_dev():
            return False
        
        # 启动前端开发服务器
        log_info("Step 2/2: Starting frontend development server...")
        return self.frontend_dev()

    def web_build(self) -> bool:
        """Build web application for production"""
        log_info("Building complete web application...")
        
        # 构建 WASM (生产版)
        log_info("Step 1/2: Building WASM for production...")
        if not self.wasm_build(dev=False):
            return False
        
        # 构建前端
        log_info("Step 2/2: Building frontend for production...")
        if not self.frontend_build():
            return False
        
        log_success(f"Web application built successfully!")
        log_info(f"📦 WASM build: {self.wasm_output_dir}")
        log_info(f"🌐 Frontend build: {self.frontend_output_dir}")
        return True

    # ===== Desktop Development Commands =====

    def desktop_dev(self) -> bool:
        """Start desktop development with Tauri"""
        log_info("Starting desktop development environment...")
        log_info(f"Working directory: {self.root_dir}")
        
        # 自动安装依赖和工具
        log_info("Step 1/4: Checking dependencies...")
        if not self.frontend_install_deps():
            return False
            
        if not self.install_tauri_cli():
            return False

        # 构建前端开发版本（可选，Tauri 会自动处理）
        log_info("Step 2/4: Preparing frontend...")
        # 这里不需要完整构建，Tauri 会启动前端开发服务器

        log_info("Step 3/4: Starting frontend dev server in background...")
        
        # Start frontend dev server in background
        shell_flag = is_windows()
        frontend_process = subprocess.Popen(
            ["yarn", "dev"],
            cwd=self.frontend_dir,
            shell=shell_flag,
            creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if is_windows() else 0
        )
        
        def cleanup_frontend():
            """Clean up frontend process and its children"""
            try:
                if is_windows():
                    # On Windows, use taskkill to terminate the entire process tree
                    subprocess.run(
                        ["taskkill", "/F", "/T", "/PID", str(frontend_process.pid)],
                        capture_output=True,
                        shell=False
                    )
                else:
                    # On Unix-like systems, terminate the process group
                    import signal
                    os.killpg(os.getpgid(frontend_process.pid), signal.SIGTERM)
                    frontend_process.wait(timeout=3)
            except Exception as e:
                log_warning(f"Error during frontend cleanup: {e}")
                try:
                    # Force kill as last resort
                    if is_windows():
                        subprocess.run(
                            ["taskkill", "/F", "/T", "/PID", str(frontend_process.pid)],
                            capture_output=True,
                            shell=False
                        )
                    else:
                        frontend_process.kill()
                except:
                    pass
        
        try:
            log_info("Waiting for frontend server to start...")
            time.sleep(3)
            
            log_info("Step 4/4: Starting Tauri desktop app...")
            log_info("Note: When you close the desktop app, the frontend server will also be stopped.")
            
            result = self.run_command(["cargo", "tauri", "dev"], cwd=self.desktop_dir)
            return result
        except KeyboardInterrupt:
            log_warning("Interrupted by user, cleaning up...")
            cleanup_frontend()
            return False
        finally:
            # Clean up frontend process
            log_info("Cleaning up frontend development server...")
            cleanup_frontend()
            log_success("Frontend server stopped.")

    def desktop_build(self, release: bool = True) -> bool:
        """Build desktop application"""
        mode = "release" if release else "debug"
        log_info(f"Building desktop application ({mode})...")
        
        if not self.frontend_install_deps():
            return False
            
        if not self.install_tauri_cli():
            return False
            
        log_info("Building frontend first...")
        if not self.frontend_build():
            return False
            
        cmd = ["cargo", "tauri", "build"]
        if not release:
            cmd.append("--debug")
        
        # 构建桌面应用
        if not self.run_command(cmd, cwd=self.desktop_dir):
            return False
        
        # 复制构建产物到统一构建目录
        return self.copy_desktop_build(release)
    
    def copy_desktop_build(self, release: bool = True) -> bool:
        """Copy desktop build artifacts to unified build directory"""
        log_info("Copying desktop build artifacts...")
        
        try:
            mode = "release" if release else "debug"
            
            # Tauri 构建输出通常在 desktop/src-tauri/target/
            tauri_target_dir = self.desktop_dir / "target" / mode
            if not tauri_target_dir.exists():
                # 备选路径
                tauri_target_dir = self.root_dir / "target" / mode
            
            if not tauri_target_dir.exists():
                log_warning(f"Desktop build artifacts not found in expected locations")
                return True  # 不失败，因为可能已经在正确位置
            
            # 创建桌面输出目录
            desktop_mode_dir = self.desktop_output_dir / mode
            desktop_mode_dir.mkdir(parents=True, exist_ok=True)
            
            # 复制可执行文件和相关文件
            for item in tauri_target_dir.iterdir():
                if item.is_file():
                    dest_path = desktop_mode_dir / item.name
                    shutil.copy2(item, dest_path)
                    log_info(f"Copied {item.name} to desktop build")
            
            log_success(f"Desktop build artifacts copied to {desktop_mode_dir}")
            return True
            
        except Exception as e:
            log_error(f"Failed to copy desktop build artifacts: {e}")
            return False

    # ===== Combined Commands =====

    def build_all(self) -> bool:
        """Build all components (web + desktop)"""
        log_info("Building all components...")
        
        if not self.web_build():
            return False
            
        return self.desktop_build()

    # ===== Utility Commands =====

    def setup_rust_targets(self) -> bool:
        """Setup required Rust targets for WASM development"""
        log_info("Setting up Rust targets...")
        
        # Add WASM target for web development
        wasm_target = "wasm32-unknown-unknown"
        try:
            # Check if target is already installed
            shell_flag = is_windows()
            result = subprocess.run(["rustup", "target", "list", "--installed"],
                                  capture_output=True, check=True,
                                  encoding='utf-8', errors='ignore', shell=shell_flag)
            if wasm_target in result.stdout:
                log_success(f"Rust target {wasm_target} already installed")
            else:
                log_info(f"Installing Rust target {wasm_target}...")
                return self.run_command(["rustup", "target", "add", wasm_target])
        except (subprocess.CalledProcessError, FileNotFoundError):
            log_warning("Could not check/install Rust targets. Make sure rustup is installed.")
        
        return True

    def setup(self) -> bool:
        """Setup complete development environment"""
        log_info("Setting up complete development environment...")
        log_info("This will install all required dependencies and tools...")
        
        # Step 1: Check that all basic tools are available
        log_info("Step 1/6: Checking required tools...")
        if not self.check_tools():
            log_error("Some required tools are missing. Please install them first.")
            return False
        
        # Step 2: Setup Rust targets and nightly toolchain
        log_info("Step 2/7: Setting up Rust targets...")
        if not self.setup_rust_targets():
            log_warning("Rust target setup failed, but continuing...")
        
        log_info("Step 3/7: Setting up nightly Rust toolchain for WASM multithreading...")
        if not self.check_nightly_toolchain():
            if not self.install_nightly_toolchain():
                log_warning("Nightly toolchain installation failed, but continuing...")
        
        # Step 4: Install/update frontend dependencies
        log_info("Step 4/7: Installing frontend dependencies...")
        if not self.frontend_install_deps(force=True):
            log_error("Frontend dependency installation failed.")
            return False
        
        # Step 5: Check and fetch Rust dependencies
        log_info("Step 5/7: Checking Rust dependencies...")
        if not self.check_rust_deps():
            log_warning("Some Rust dependency checks failed, but continuing...")
        
        # Step 6: Install Tauri CLI
        log_info("Step 6/7: Installing Tauri CLI...")
        if not self.install_tauri_cli():
            log_error("Tauri CLI installation failed.")
            return False
        
        # Step 7: Install additional cargo tools
        log_info("Step 7/7: Installing additional development tools...")
        if not self.install_cargo_tools():
            log_warning("Some cargo tools installation failed, but continuing...")
        
        log_success("✨ Development environment setup complete!")
        log_info("You can now use:")
        print("  📦 python build.py web-dev      # Start web development")
        print("  🖥️  python build.py desktop-dev   # Start desktop development")
        print("  📊 python build.py status       # Check project status")
        
        return True

    def clean_all(self) -> bool:
        """Clean all build artifacts"""
        log_info("Cleaning all build artifacts...")
        
        # Clean Rust artifacts (includes target/)
        self.run_command(["cargo", "clean"])
        
        # Clean unified build directory specifically
        if self.build_dir.exists():
            log_step(f"Removing unified build directory: {self.build_dir}")
            shutil.rmtree(self.build_dir, ignore_errors=True)
        
        # Clean frontend artifacts
        frontend_paths_to_clean = [
            self.frontend_dir / "node_modules",
            self.frontend_dir / ".svelte-kit",
            self.frontend_dir / "build",
            self.frontend_dir / "src" / "lib" / "wasm-pkg"  # 清理前端lib中的WASM包
        ]
        
        # Clean WASM artifacts
        wasm_paths_to_clean = [
            self.core_dir / "pkg"
        ]
        
        all_paths = frontend_paths_to_clean + wasm_paths_to_clean
        
        for path in all_paths:
            if path.exists():
                log_step(f"Removing {path}")
                shutil.rmtree(path, ignore_errors=True)
        
        log_success("All clean! 🧹")
        return True

    def format_all(self) -> bool:
        """Format all code"""
        log_info("Formatting all code...")
        
        # Format Rust code
        if not self.run_command(["cargo", "fmt"]):
            return False
            
        # Format frontend code
        if self.frontend_install_deps():
            self.run_command(["yarn", "format"], cwd=self.frontend_dir)
            
        log_success("All code formatted!")
        return True

    def lint_all(self) -> bool:
        """Lint all code"""
        log_info("Linting all code...")
        
        # Lint Rust code
        if not self.run_command(["cargo", "clippy", "--", "-D", "warnings"]):
            return False
            
        # Lint frontend code
        if self.frontend_install_deps():
            if not self.run_command(["yarn", "lint"], cwd=self.frontend_dir):
                return False
                
        log_success("All code linted!")
        return True

    def test(self) -> bool:
        """Run all tests"""
        log_info("Running Rust tests...")
        if not self.run_command(["cargo", "test"]):
            return False
            
        log_info("Running frontend tests...")
        if self.frontend_install_deps():
            # Try to run frontend tests, but don't fail if not configured
            result = self.run_command(["yarn", "test"], cwd=self.frontend_dir)
            if not result:
                log_warning("No frontend tests configured or tests failed")
                
        log_success("Tests completed!")
        return True

    def status(self) -> bool:
        """Show project status"""
        log_info("Project Status:")
        
        print("\nFrontend dependencies:")
        try:
            shell_flag = is_windows()
            result = subprocess.run(
                ["yarn", "list", "--depth=0"],
                cwd=self.frontend_dir,
                capture_output=True,
                text=True,
                encoding='utf-8',
                errors='ignore',
                shell=shell_flag
            )
            lines = result.stdout.split('\n')[:5]
            for line in lines:
                if line.strip():
                    print(f"  {line}")
        except:
            print("  Unable to get frontend dependencies")
        
        print("\nRust components:")
        try:
            shell_flag = is_windows()
            result = subprocess.run(
                ["cargo", "tree", "--workspace", "--depth=1"],
                capture_output=True,
                text=True,
                encoding='utf-8',
                errors='ignore',
                shell=shell_flag
            )
            lines = result.stdout.split('\n')[:10]
            for line in lines:
                if line.strip():
                    print(f"  {line}")
        except:
            print("  Unable to get Rust components")
        
        print("\nBuild artifacts:")
        wasm_pkg = self.core_dir / "pkg"
        if wasm_pkg.exists():
            files = list(wasm_pkg.iterdir())[:3]
            for file in files:
                print(f"  {file.name}")
        else:
            print("  No WASM build artifacts")
            
        return True

    def watch(self) -> bool:
        """Hot reload development (auto-rebuild WASM on changes)"""
        log_info("Starting hot reload development...")
        log_info("This will watch for Rust changes and rebuild WASM automatically")
        
        try:
            shell_flag = is_windows()
            subprocess.run(["cargo", "watch", "--version"],
                         capture_output=True, check=True,
                         encoding='utf-8', errors='ignore', shell=shell_flag)
            log_success("cargo-watch is available")
        except subprocess.CalledProcessError:
            log_error("cargo-watch is not installed. Run 'python build.py setup' to install it.")
            return False
        
        return self.run_command([
            "cargo", "watch", 
            "-w", "core", 
            "-s", "python build.py wasm-dev"
        ])

def main():
    parser = argparse.ArgumentParser(
        description="Bubblefish Development Build Script",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Available commands:
  🚀 Getting Started:
    setup         Complete development environment setup

  🌐 Web Development:
    web-dev       Start web development (WASM + Frontend)
    web-build     Build web application
    frontend-dev  Frontend dev server only
    frontend-build Frontend build only

  🪟 Desktop Development:
    desktop-dev   Start desktop development (auto)
    desktop-build Build desktop application

  🔨 Building:
    build-all     Build everything (web + desktop)
    wasm-build    Build WASM (production)
    wasm-dev      Build WASM (development)

  🛠️ Development Tools:
    watch         Auto-rebuild WASM on changes
    test          Run all tests
    status        Show project status

  🧹 Maintenance:
    clean-all     Clean everything (target/, node_modules/, etc.)
    clean         Clean unified build directory only
    validate      Validate build artifacts exist
    format-all    Format all code
    lint-all      Lint all code

  📋 Help:
    help          Show this help message
        """
    )
    
    parser.add_argument("command", nargs="?", default="help", help="Command to run")
    parser.add_argument("--release", action="store_true", help="Build in release mode")
    parser.add_argument("--debug", action="store_true", help="Build in debug mode")
    
    args = parser.parse_args()
    
    build_script = BuildScript()
    
    # Command mapping
    commands = {
        # Web development
        "web-dev": build_script.web_dev,
        "web-build": build_script.web_build,
        "frontend-dev": build_script.frontend_dev,
        "frontend-build": build_script.frontend_build,
        "wasm-build": lambda: build_script.wasm_build(dev=False),
        "wasm-dev": build_script.wasm_dev,
        
        # Desktop development
        "desktop-dev": build_script.desktop_dev,
        "desktop-build": lambda: build_script.desktop_build(release=not args.debug),
        
        # Combined commands
        "build-all": build_script.build_all,
        
        # Utility commands
        "setup": build_script.setup,
        "clean-all": build_script.clean_all,
        "clean": build_script.clean_build_dir,
        "validate": build_script.validate_build_artifacts,
        "format-all": build_script.format_all,
        "lint-all": build_script.lint_all,
        "test": build_script.test,
        "status": build_script.status,
        "watch": build_script.watch,
        
        # Help
        "help": lambda: parser.print_help() or True,
        "list": lambda: parser.print_help() or True,
    }
    
    if args.command not in commands:
        log_error(f"Unknown command: {args.command}")
        parser.print_help()
        sys.exit(1)
    
    try:
        success = commands[args.command]()
        if not success:
            log_error(f"Command '{args.command}' failed")
            sys.exit(1)
        else:
            log_success(f"Command '{args.command}' completed successfully")
    except KeyboardInterrupt:
        log_warning("Interrupted by user")
        sys.exit(1)
    except Exception as e:
        log_error(f"Unexpected error: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main() 
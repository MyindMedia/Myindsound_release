
interface UnicornSceneConfig {
    elementId: string;
    projectId: string;
    scale?: number;
    dpi?: number;
    fps?: number;
    lazyLoad?: boolean;
    production?: boolean;
    interactivity?: {
        mouse?: {
            disableMobile?: boolean;
        };
    };
}

declare const UnicornStudio: {
    init: () => void;
    addScene: (config: UnicornSceneConfig) => Promise<any>;
    destroy: () => void;
};

export class UnicornSceneManager {
    private static scenes: Map<string, any> = new Map();
    private static defaultProjectId = "ryXCGIJHz1KVR0TZRWND";

    /**
     * Initialize a Unicorn Studio scene in a specific container
     */
    /**
     * Initialize a Unicorn Studio scene in a specific container
     */
    static async init(containerId: string, _projectId: string = this.defaultProjectId) {
        // Check if container exists
        const container = document.getElementById(containerId);
        if (!container) {
            console.warn(`UnicornSceneManager: Container #${containerId} not found.`);
            return;
        }

        // Check if scene already exists
        if (this.scenes.has(containerId)) {
            console.log(`UnicornSceneManager: Scene already exists in #${containerId}`);
            return;
        }

        try {
            console.log(`UnicornSceneManager: Loading local scene data for #${containerId}`);

            // Fetch local JSON with cache busting
            const response = await fetch(`/assets/unicorn-scene.json?t=${Date.now()}`);
            if (!response.ok) throw new Error('Failed to load scene JSON');
            const sceneData = await response.json();

            // Initialize with local data
            // We use the ID from the JSON or the default, but passing 'data' is key if supported
            // If the SDK supports offline loading, it typically overrides projectId lookup
            const scene = await UnicornStudio.addScene({
                elementId: containerId,
                projectId: sceneData.id || _projectId, // Still provide ID 
                data: sceneData, // Pass the full JSON data
                scale: 1,
                dpi: 1.5,
                fps: 60,
                lazyLoad: true,
                production: true, // Should hide badge if licensed
                interactivity: {       // Add interactivity from JSON options if needed, but safe defaults here
                    mouse: {
                        disableMobile: true
                    }
                }
            } as any); // Cast to any to bypass our limited interface definition

            this.scenes.set(containerId, scene);
            console.log(`UnicornSceneManager: Scene initialized with local data`, scene);

            // Programmatically remove badge with aggressive checking
            this.removeBadge(containerId);

            return scene;
        } catch (err) {
            console.error("UnicornSceneManager: Failed to initialize scene", err);
        }
    }

    private static removeBadge(containerId: string) {
        const checkForBadge = () => {
            // 1. Check Light DOM
            const badges = document.querySelectorAll('a[href*="unicorn.studio"], .us-badge, .us-logo');
            badges.forEach(el => el.remove());

            // 2. Check Shadows (if accessible, though unlikely for this lib version)
            // 3. Check Text Content
            const allElements = document.body.getElementsByTagName('*');
            for (let i = 0; i < allElements.length; i++) {
                const el = allElements[i] as HTMLElement;
                if (el.shadowRoot) {
                    const shadowBadges = el.shadowRoot.querySelectorAll('a[href*="unicorn.studio"]');
                    shadowBadges.forEach(b => b.remove());
                }
                if (el.textContent && el.textContent.toLowerCase().includes('made with unicorn.studio') && el.tagName !== 'SCRIPT' && el.tagName !== 'STYLE') {
                    // Create a more specific check to verify it's the badge
                    if (el.tagName === 'A' || el.classList.contains('us-badge')) {
                        el.remove();
                    }
                }
            }
        };

        // Check immediately
        checkForBadge();

        // Check continuously for a few seconds
        const interval = setInterval(checkForBadge, 100);
        setTimeout(() => clearInterval(interval), 5000); // Stop after 5 seconds

        // Mutation Observer for long-term (if it reinjects)
        const observer = new MutationObserver((mutations) => {
            checkForBadge();
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }

    /**
     * Destroy a specific scene or all scenes
     */
    static destroy(containerId?: string) {
        if (containerId) {
            const scene = this.scenes.get(containerId);
            if (scene) {
                if (scene.destroy) scene.destroy();
                this.scenes.delete(containerId);
            }
        } else {
            // Destroy all
            this.scenes.forEach((scene) => {
                if (scene.destroy) scene.destroy();
            });
            this.scenes.clear();
        }
    }
}

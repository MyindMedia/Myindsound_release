
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
    private static defaultProjectId = "h4HiZ0HrC5hQkgRlxuEw";

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
            console.log(`UnicornSceneManager: Loading scene for #${containerId} with Project ID: ${_projectId}`);

            // Initialize using Unicorn Studio SDK with Project ID
            const scene = await UnicornStudio.addScene({
                elementId: containerId,
                projectId: _projectId,
                scale: 1,
                dpi: 1.5,
                fps: 60,
                lazyLoad: true,
                production: true, // Enable CDN caching
                interactivity: {
                    mouse: {
                        disableMobile: true
                    }
                }
            } as any);

            this.scenes.set(containerId, scene);
            console.log(`UnicornSceneManager: Scene initialized`, scene);

            // Programmatically remove badge with aggressive checking
            this.removeBadge(containerId);

            return scene;
        } catch (err) {
            console.error("UnicornSceneManager: Failed to initialize scene", err);
        }
    }

    private static removeBadge(_containerId: string) {
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
        const observer = new MutationObserver((_mutations) => {
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

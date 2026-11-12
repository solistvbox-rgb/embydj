using System;
using System.Collections.Generic;
using System.IO;
using EmbyDJ.Configuration;
using EmbyDJ.Storage;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Controller;
using MediaBrowser.Model.Drawing;
using MediaBrowser.Model.Logging;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model.Serialization;

namespace EmbyDJ
{
    /// <summary>
    /// EmbyDJ: a browser-based two-deck DJ mixer that plays tracks from the Emby music library.
    /// The plugin itself (1) serves the web app, (2) adds a dashboard menu entry that hosts it,
    /// (3) stores per-track DJ metadata (BPM, beat offset, cue points) and (4) stores the sampler
    /// pads and uploaded samples per user. Administrators only.
    /// </summary>
    public class Plugin : BasePlugin<PluginConfiguration>, IHasWebPages, IHasThumbImage
    {
        /// <summary>Logo on Dashboard -> Plugins (300 x 167 WebP, embedded).</summary>
        public Stream GetThumbImage() => GetType().Assembly.GetManifestResourceStream(GetType().Namespace + ".thumb.webp");

        public ImageFormat ThumbImageFormat => ImageFormat.Webp;

        public static Plugin Instance { get; private set; }

        public IServerApplicationHost ApplicationHost { get; }
        public TrackStore Tracks { get; }
        public SamplerStore Sampler { get; }
        public ILogger Logger { get; }

        public Plugin(
            IApplicationPaths appPaths,
            IXmlSerializer xmlSerializer,
            IServerApplicationHost applicationHost,
            ILogManager logManager)
            : base(appPaths, xmlSerializer)
        {
            Instance = this;
            ApplicationHost = applicationHost;
            Logger = logManager.GetLogger("EmbyDJ");
            Tracks = new TrackStore(appPaths, Logger);
            Sampler = new SamplerStore(appPaths, Logger);
        }

        public override string Name => "EmbyDJ";
        public override Guid Id => new Guid("6f3b2a71-9c4e-4d8a-b1f5-2e7d0c9a4b63");
        public override string Description =>
            "Browser-based two-deck DJ mixer for your Emby music library.";

        /// <summary>
        /// Called by Emby right before the plugin is uninstalled (Emby itself only deletes the DLL).
        /// Removes all EmbyDJ data: track metadata, sampler pads and samples, and the configuration
        /// file. Every part is non-fatal, so Emby can always finish the uninstall. Until the next
        /// restart the stores refuse writes, so a still-open EmbyDJ page cannot recreate the files.
        /// </summary>
        public override void OnUninstalling()
        {
            base.OnUninstalling();

            try { Tracks.DeleteAll(); }
            catch (Exception ex) { Logger.ErrorException("EmbyDJ: could not delete the track metadata during uninstall.", ex); }

            try { Sampler.DeleteAll(); }
            catch (Exception ex) { Logger.ErrorException("EmbyDJ: could not delete the sampler data during uninstall.", ex); }

            try
            {
                var configXml = Path.Combine(ApplicationPaths.PluginConfigurationsPath, "EmbyDJ.xml");
                if (File.Exists(configXml)) File.Delete(configXml);
            }
            catch (Exception ex) { Logger.ErrorException("EmbyDJ: could not delete the configuration file during uninstall.", ex); }
        }

        public IEnumerable<PluginPageInfo> GetPages()
        {
            return new[]
            {
                new PluginPageInfo
                {
                    Name = "EmbyDJ",
                    EmbeddedResourcePath = GetType().Namespace + ".Web.dashboard.html",
                    IsMainConfigPage = true,
                    EnableInMainMenu = true,
                    MenuIcon = "album",
                    DisplayName = "EmbyDJ"
                },
                new PluginPageInfo
                {
                    Name = "embydjdashboard",
                    EmbeddedResourcePath = GetType().Namespace + ".Web.dashboard.js"
                }
            };
        }
    }
}

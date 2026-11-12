using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Model.Logging;

namespace EmbyDJ.Storage
{
    /// <summary>
    /// Sampler data, per Emby user:
    ///   {DataPath}/embydj-sampler/{userId}/pads.json      - pad layout (opaque JSON object owned by the web app)
    ///   {DataPath}/embydj-sampler/{userId}/{sampleId}.ext - uploaded audio (local files, loop captures)
    /// </summary>
    public class SamplerStore
    {
        public const long MaxSampleBytes = 10 * 1024 * 1024;
        private const int MaxPadsJsonLength = 256 * 1024;

        private static readonly Dictionary<string, string> AudioTypes = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            [".wav"] = "audio/wav",
            [".mp3"] = "audio/mpeg",
            [".flac"] = "audio/flac",
            [".ogg"] = "audio/ogg",
            [".oga"] = "audio/ogg",
            [".opus"] = "audio/ogg",
            [".m4a"] = "audio/mp4",
            [".aac"] = "audio/aac",
            [".webm"] = "audio/webm",
            [".aif"] = "audio/aiff",
            [".aiff"] = "audio/aiff"
        };

        private static readonly Regex IdPattern = new Regex("^[0-9a-f]{32}$", RegexOptions.Compiled);

        private readonly string _root;
        private readonly ILogger _logger;
        private readonly object _lock = new object();

        public SamplerStore(IApplicationPaths appPaths, ILogger logger)
        {
            _root = Path.Combine(appPaths.DataPath, "embydj-sampler");
            _logger = logger;
        }

        private volatile bool _deleted;

        /// <summary>Uninstall: deletes all pads and samples of all users and refuses further writes until the server restarts.</summary>
        public void DeleteAll()
        {
            _deleted = true;
            lock (_lock)
            {
                if (Directory.Exists(_root)) Directory.Delete(_root, true);
            }
        }

        private string UserDir(string userId)
        {
            if (_deleted) throw new InvalidOperationException("EmbyDJ is being uninstalled");
            if (string.IsNullOrEmpty(userId) || !IdPattern.IsMatch(userId)) throw new UnauthorizedAccessException("Unknown user");
            var dir = Path.Combine(_root, userId);
            Directory.CreateDirectory(dir);
            return dir;
        }

        public static bool IsSupportedExtension(string ext) => ext != null && AudioTypes.ContainsKey(ext);

        // ---- pads ----

        public string GetPads(string userId)
        {
            var file = Path.Combine(UserDir(userId), "pads.json");
            lock (_lock)
            {
                return File.Exists(file) ? File.ReadAllText(file) : null;
            }
        }

        public void SetPads(string userId, string json)
        {
            if (string.IsNullOrWhiteSpace(json) || json.Length > MaxPadsJsonLength) throw new ArgumentException("Invalid pad data");
            using (var doc = JsonDocument.Parse(json))
            {
                if (doc.RootElement.ValueKind != JsonValueKind.Object) throw new ArgumentException("Pad data must be a JSON object");
            }
            var file = Path.Combine(UserDir(userId), "pads.json");
            lock (_lock)
            {
                var tmp = file + ".tmp";
                File.WriteAllText(tmp, json);
                if (File.Exists(file)) File.Replace(tmp, file, null);
                else File.Move(tmp, file);
            }
        }

        // ---- samples ----

        /// <summary>Stores an uploaded sample and returns its id. Rejects unknown types and files over the size limit.</summary>
        // Async on purpose: Kestrel disallows synchronous reads of the request body.
        public async Task<string> SaveSampleAsync(string userId, string fileName, Stream data)
        {
            var ext = Path.GetExtension(fileName ?? "");
            if (!IsSupportedExtension(ext)) throw new ArgumentException("Unsupported audio type: " + ext);

            var id = Guid.NewGuid().ToString("N");
            var path = Path.Combine(UserDir(userId), id + ext.ToLowerInvariant());
            try
            {
                using (var file = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None, 81920, true))
                {
                    var buffer = new byte[81920];
                    long total = 0;
                    int read;
                    while ((read = await data.ReadAsync(buffer, 0, buffer.Length).ConfigureAwait(false)) > 0)
                    {
                        total += read;
                        if (total > MaxSampleBytes) throw new ArgumentException("Sample larger than 10 MB");
                        await file.WriteAsync(buffer, 0, read).ConfigureAwait(false);
                    }
                    if (total == 0) throw new ArgumentException("Empty upload");
                }
            }
            catch
            {
                try { File.Delete(path); } catch { /* ignore */ }
                throw;
            }
            return id;
        }

        public bool TryOpenSample(string userId, string sampleId, out Stream stream, out string contentType)
        {
            stream = null;
            contentType = null;
            var path = FindSample(userId, sampleId);
            if (path == null) return false;
            contentType = AudioTypes[Path.GetExtension(path)];
            stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
            return true;
        }

        public void DeleteSample(string userId, string sampleId)
        {
            var path = FindSample(userId, sampleId);
            if (path == null) return;
            try { File.Delete(path); }
            catch (Exception ex) { _logger.ErrorException("EmbyDJ: could not delete sample " + path, ex); }
        }

        private string FindSample(string userId, string sampleId)
        {
            if (sampleId == null || !IdPattern.IsMatch(sampleId)) return null;
            return Directory.GetFiles(UserDir(userId), sampleId + ".*")
                .FirstOrDefault(p => IsSupportedExtension(Path.GetExtension(p)));
        }
    }
}

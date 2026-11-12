using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Model.Logging;

namespace EmbyDJ.Storage
{
    /// <summary>
    /// Per-track DJ metadata (BPM, beat offset, cue / hot-cue points), keyed by Emby item id.
    /// The web app owns the shape of each entry; the server stores it as an opaque JSON object
    /// so new fields need no server change. Persisted to {DataPath}/embydj-tracks.json.
    /// </summary>
    public class TrackStore
    {
        private const int MaxEntryLength = 16 * 1024;

        private readonly string _filePath;
        private readonly ILogger _logger;
        private readonly object _lock = new object();
        private Dictionary<string, JsonElement> _entries;
        private bool _deleted;

        /// <summary>Uninstall: deletes the file and refuses further writes until the server restarts.</summary>
        public void DeleteAll()
        {
            lock (_lock)
            {
                _deleted = true;
                _entries = new Dictionary<string, JsonElement>(StringComparer.OrdinalIgnoreCase);
                foreach (var path in new[] { _filePath, _filePath + ".tmp" })
                    if (File.Exists(path)) File.Delete(path);
            }
        }

        public TrackStore(IApplicationPaths appPaths, ILogger logger)
        {
            _filePath = Path.Combine(appPaths.DataPath, "embydj-tracks.json");
            _logger = logger;
        }

        public Dictionary<string, JsonElement> Get(IEnumerable<string> ids)
        {
            var result = new Dictionary<string, JsonElement>(StringComparer.OrdinalIgnoreCase);
            lock (_lock)
            {
                var all = Load();
                foreach (var id in ids)
                {
                    if (!string.IsNullOrEmpty(id) && all.TryGetValue(id, out var value))
                        result[id] = value;
                }
            }
            return result;
        }

        public Dictionary<string, JsonElement> GetAll()
        {
            lock (_lock)
            {
                return new Dictionary<string, JsonElement>(Load(), StringComparer.OrdinalIgnoreCase);
            }
        }

        /// <summary>Stores <paramref name="json"/> (must be a JSON object) for an item; null/empty deletes it.</summary>
        public void Set(string id, string json)
        {
            if (string.IsNullOrWhiteSpace(id)) throw new ArgumentException("Id is required");

            JsonElement? value = null;
            if (!string.IsNullOrWhiteSpace(json))
            {
                if (json.Length > MaxEntryLength) throw new ArgumentException("Track data too large");
                using (var doc = JsonDocument.Parse(json))
                {
                    if (doc.RootElement.ValueKind != JsonValueKind.Object)
                        throw new ArgumentException("Track data must be a JSON object");
                    value = doc.RootElement.Clone();
                }
            }

            lock (_lock)
            {
                if (_deleted) throw new InvalidOperationException("EmbyDJ is being uninstalled");
                var all = Load();
                if (value.HasValue) all[id] = value.Value;
                else all.Remove(id);
                Save(all);
            }
        }

        private Dictionary<string, JsonElement> Load()
        {
            if (_entries != null) return _entries;
            _entries = new Dictionary<string, JsonElement>(StringComparer.OrdinalIgnoreCase);
            try
            {
                if (File.Exists(_filePath))
                {
                    var loaded = JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(File.ReadAllText(_filePath));
                    if (loaded != null)
                        foreach (var kv in loaded) _entries[kv.Key] = kv.Value;
                }
            }
            catch (Exception ex)
            {
                _logger.ErrorException("EmbyDJ: could not read " + _filePath, ex);
            }
            return _entries;
        }

        private void Save(Dictionary<string, JsonElement> all)
        {
            var tmp = _filePath + ".tmp";
            File.WriteAllText(tmp, JsonSerializer.Serialize(all));
            if (File.Exists(_filePath)) File.Replace(tmp, _filePath, null);
            else File.Move(tmp, _filePath);
        }
    }
}

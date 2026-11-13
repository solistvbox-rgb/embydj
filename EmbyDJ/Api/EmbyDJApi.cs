using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;
using MediaBrowser.Controller.Net;
using MediaBrowser.Model.Services;

namespace EmbyDJ.Api
{
    // ---- Web app (static, no auth: contains no data, the app authenticates its own API calls) ----

    [Unauthenticated]
    [Route("/EmbyDJ/Web/{Name}", "GET", Summary = "EmbyDJ web app files")]
    public class GetWebFile : IReturn<object>
    {
        public string Name { get; set; }
        public string V { get; set; }
    }

    [Unauthenticated]
    [Route("/EmbyDJ/Version", "GET", Summary = "Running EmbyDJ version")]
    public class GetVersion : IReturn<object> { }

    // ---- Track metadata ----

    [Authenticated(Roles = "Admin")]
    [Route("/EmbyDJ/Tracks", "GET", Summary = "DJ metadata (BPM, cues) for a comma-separated list of item ids, or All=true for every track")]
    public class GetTracks : IReturn<object>
    {
        public string Ids { get; set; }
        public bool All { get; set; }
    }

    [Authenticated(Roles = "Admin")]
    [Route("/EmbyDJ/Tracks/{Id}", "POST", Summary = "Store DJ metadata for one item (Data = JSON object, empty deletes)")]
    public class SetTrack : IReturnVoid
    {
        public string Id { get; set; }
        public string Data { get; set; }
    }

    // ---- Sampler (per user) ----

    [Authenticated(Roles = "Admin")]
    [Route("/EmbyDJ/Sampler/Pads", "GET", Summary = "Pad layout of the current user (JSON object, empty if none)")]
    public class GetPads : IReturn<object> { }

    [Authenticated(Roles = "Admin")]
    [Route("/EmbyDJ/Sampler/Pads", "POST", Summary = "Store the pad layout of the current user (Data = JSON object)")]
    public class SetPads : IReturnVoid
    {
        public string Data { get; set; }
    }

    [Authenticated(Roles = "Admin")]
    [Route("/EmbyDJ/Midi/Profiles", "GET", Summary = "Saved MIDI controller profiles of the current user (JSON object, empty if none)")]
    public class GetMidiProfiles : IReturn<object> { }

    [Authenticated(Roles = "Admin")]
    [Route("/EmbyDJ/Midi/Profiles", "POST", Summary = "Store the MIDI controller profiles of the current user (Data = JSON object)")]
    public class SetMidiProfiles : IReturnVoid
    {
        public string Data { get; set; }
    }

    [Authenticated(Roles = "Admin")]
    [Route("/EmbyDJ/Sampler/Samples", "POST", Summary = "Upload a sample (raw request body, Name = original file name). Max 10 MB.")]
    public class UploadSample : IRequiresRequestStream, IReturn<object>
    {
        public string Name { get; set; }
        public Stream RequestStream { get; set; }
    }

    [Authenticated(Roles = "Admin")]
    [Route("/EmbyDJ/Sampler/Samples/{Id}", "GET", Summary = "Download a sample of the current user")]
    public class GetSample : IReturn<object>
    {
        public string Id { get; set; }
    }

    [Authenticated(Roles = "Admin")]
    [Route("/EmbyDJ/Sampler/Samples/{Id}", "DELETE", Summary = "Delete a sample of the current user")]
    public class DeleteSample : IReturnVoid
    {
        public string Id { get; set; }
    }

    public class EmbyDJApi : IService, IRequiresRequest
    {
        public IRequest Request { get; set; }

        private static Plugin P => Plugin.Instance;

        private static readonly Dictionary<string, string> WebFiles = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["index.html"] = "text/html; charset=utf-8",
            ["app.js"] = "application/javascript; charset=utf-8",
            ["app.css"] = "text/css; charset=utf-8",
            ["deck-worklet.js"] = "application/javascript; charset=utf-8"
        };

        private static readonly ConcurrentDictionary<string, byte[]> FileCache = new ConcurrentDictionary<string, byte[]>(StringComparer.OrdinalIgnoreCase);

        private IHttpResultFactory ResultFactory => P.ApplicationHost.Resolve<IHttpResultFactory>();

        public object Get(GetWebFile request)
        {
            string contentType;
            if (request.Name == null || !WebFiles.TryGetValue(request.Name, out contentType))
                throw new FileNotFoundException("Unknown file");

            var bytes = FileCache.GetOrAdd(request.Name, name =>
            {
                var resource = typeof(Plugin).Namespace + ".Web." + name;
                using (var stream = typeof(Plugin).Assembly.GetManifestResourceStream(resource))
                {
                    if (stream == null) throw new FileNotFoundException(resource);
                    using (var ms = new MemoryStream())
                    {
                        stream.CopyTo(ms);
                        return ms.ToArray();
                    }
                }
            });

            return ResultFactory.GetResult(Request, new MemoryStream(bytes, false), contentType,
                new Dictionary<string, string> { ["Cache-Control"] = "no-cache" });
        }

        public object Get(GetVersion request) => new { Version = CurrentVersion };

        public object Get(GetTracks request)
        {
            var ids = (request.Ids ?? "").Split(new[] { ',' }, StringSplitOptions.RemoveEmptyEntries)
                .Select(s => s.Trim()).Take(500);
            var json = JsonSerializer.Serialize(request.All ? P.Tracks.GetAll() : P.Tracks.Get(ids));
            return ResultFactory.GetResult(Request, new MemoryStream(Encoding.UTF8.GetBytes(json), false),
                "application/json; charset=utf-8", new Dictionary<string, string> { ["Cache-Control"] = "no-store" });
        }

        public void Post(SetTrack request)
        {
            P.Tracks.Set(request.Id, request.Data);
        }

        // ---- sampler ----

        /// <summary>Id (32 hex chars) of the user making the request.</summary>
        private string CurrentUserId()
        {
            var auth = P.ApplicationHost.Resolve<IAuthorizationContext>();
            var user = auth?.GetAuthorizationInfo(Request)?.User;
            if (user == null) throw new UnauthorizedAccessException("No user");
            return user.Id.ToString("N");
        }

        private object JsonResult(string json)
        {
            return ResultFactory.GetResult(Request, new MemoryStream(Encoding.UTF8.GetBytes(json ?? "{}"), false),
                "application/json; charset=utf-8", new Dictionary<string, string> { ["Cache-Control"] = "no-store" });
        }

        public object Get(GetPads request) => JsonResult(P.Sampler.GetPads(CurrentUserId()));

        public void Post(SetPads request) => P.Sampler.SetPads(CurrentUserId(), request.Data);

        public object Get(GetMidiProfiles request) => JsonResult(P.Sampler.GetMidiProfiles(CurrentUserId()));

        public void Post(SetMidiProfiles request) => P.Sampler.SetMidiProfiles(CurrentUserId(), request.Data);

        public async Task<object> Post(UploadSample request)
        {
            var id = await P.Sampler.SaveSampleAsync(CurrentUserId(), request.Name, request.RequestStream).ConfigureAwait(false);
            return JsonResult(JsonSerializer.Serialize(new { Id = id }));
        }

        public object Get(GetSample request)
        {
            Stream stream;
            string contentType;
            if (!P.Sampler.TryOpenSample(CurrentUserId(), request.Id, out stream, out contentType))
                throw new FileNotFoundException("Sample not found");
            return ResultFactory.GetResult(Request, stream, contentType,
                new Dictionary<string, string> { ["Cache-Control"] = "private, max-age=31536000, immutable" });
        }

        public void Delete(DeleteSample request) => P.Sampler.DeleteSample(CurrentUserId(), request.Id);

        internal static string CurrentVersion => typeof(Plugin).Assembly.GetName().Version.ToString(4);
    }
}

/*
 * EmbyDJ dashboard shell. Hosts the DJ app (/EmbyDJ/Web/index.html) in an iframe on the same
 * origin; the app picks up the logged-in user's ApiClient from window.parent / window.opener.
 * Keep this file stable - Emby caches it keyed by the server version only.
 */
define(['baseView'], function (BaseView) {
    'use strict';

    function appUrl() {
        return ApiClient.getUrl('EmbyDJ/Web/index.html', { v: Date.now() });
    }

    function View(view, params) {
        BaseView.apply(this, arguments);

        var frame = view.querySelector('.embydj-frame');
        var shell = view.querySelector('.embydj-shell');
        function fit() {
            // Emby's page header is position:fixed and would cover the top of the app:
            // push the content down below it.
            var header = document.querySelector('.skinHeader');
            var headerBottom = header && header.offsetHeight ? header.getBoundingClientRect().bottom : 0;
            var pad = Math.max(8, Math.ceil(headerBottom - shell.getBoundingClientRect().top) + 8) + 'px';
            if (shell.style.paddingTop !== pad) shell.style.paddingTop = pad;
            var top = frame.getBoundingClientRect().top;
            var h = Math.max(500, window.innerHeight - top - 12) + 'px';
            if (frame.style.height !== h) frame.style.height = h;
        }

        // Load the app while this view is visible and unload it while hidden. Emby keeps paused
        // views alive in its view cache (sometimes several instances of the same page), so a
        // hidden instance must never keep playing. Lifecycle callbacks are not reliable enough
        // for that on their own, so a light visibility check backs them up.
        // For a mix that survives navigating around Emby, use "Open in new tab".
        function isLoaded() { return (frame.getAttribute('src') || '').indexOf('/EmbyDJ/Web/') !== -1; }
        function isVisible() { return frame.offsetWidth > 0 && !view.classList.contains('page-hidden') && !view.classList.contains('hide'); }
        function sync() {
            if (isVisible()) {
                if (!isLoaded()) frame.setAttribute('src', appUrl());
                fit();
            } else if (isLoaded()) {
                frame.setAttribute('src', 'about:blank');
            }
        }
        var timer = setInterval(sync, 400);
        window.addEventListener('resize', fit);

        this.onResume = function () {
            BaseView.prototype.onResume.apply(this, arguments);
            setTimeout(sync, 0);
        };

        this.onPause = function () {
            BaseView.prototype.onPause.apply(this, arguments);
            setTimeout(sync, 0);
        };

        this.destroy = function () {
            clearInterval(timer);
            window.removeEventListener('resize', fit);
            frame.setAttribute('src', 'about:blank');
            BaseView.prototype.destroy.apply(this, arguments);
        };
    }

    View.prototype = Object.create(BaseView.prototype);
    View.prototype.constructor = View;
    return View;
});

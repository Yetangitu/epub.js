EPUBJS.reader = {};
EPUBJS.reader.plugins = {}; //-- Attach extra Controllers as plugins (like search?)

(function(root, $) {

    var previousReader = root.ePubReader || {};

    var ePubReader = root.ePubReader = function(path, options) {
        return new EPUBJS.Reader(path, options);
    };

    //exports to multiple environments
    if (typeof define === 'function' && define.amd) {
        //AMD
        define(function(){ return Reader; });
    } else if (typeof module != "undefined" && module.exports) {
        //Node
        module.exports = ePubReader;
    }

})(window, jQuery);

EPUBJS.Reader = function(bookPath, _options) {
    var reader = this,
        book,
        renderer,
        plugin,
        $viewer = $("#viewer"),
        search = window.location.search,
        parameters;

    this.settings = EPUBJS.core.defaults(_options || {}, {
        bookPath : bookPath,
        contained : undefined,
        sidebarReflow: false,
        generatePagination: false,
        history: true,
        keyboard: {
            32: 'next', // space
            34: 'next', // page-down
            39: 'next', // cursor-right
            33: 'previous', // page-up
            37: 'previous', // cursor-left
            36: 'first', // home
            35: 'last', // end
            65: 'annotate', // a
            66: 'bookmark', // b
            82: 'reflow', // r
            83: 'toggleSidebar', // s
            84: 'toolbar', // t
            68: 'toggleDay', // d
            78: 'toggleNight', // n
            70: 'toggleFullscreen', // f
            27: 'closeSidebar' // esc
        },
        nightMode: false,
        dayMode: false,
        maxWidth: 72,
        pageArrows: false,
        annotations: {},
        customStyles: {},
        activeStyles: {},
        session: {}
    });

    // used for annotations and bookmarks
    this.Annotation = function (type, anchor, body, id) {
        this.id = id || EPUBJS.core.uuid();
        this.type = type;
        this.date = Date.now();
        this.edited = this.date;
        this.anchor = anchor;
        this.body = body;
    };

    // used for UI and book styles
    this.Style = function (name, selector, rules, extra) {
        this.name = name;
        this.selector = selector;
        this.rules = rules;
        this.extra = extra || null;
    };    

    // Overide options with search parameters
    if(search) {
        parameters = search.slice(1).split("&");
        parameters.forEach(function(p){
            var split = p.split("=");
            var name = split[0];
            var value = split[1] || '';
            reader.settings[name] = decodeURIComponent(value);
        });
    }

    this.restoreDefaults(this.settings.session.defaults);
    this.restorePreferences(this.settings.session.preferences);
    this.restoreAnnotations(this.settings.session.annotations);

    this.book = book = new EPUBJS.Book(this.settings);

    this.offline = false;
    this.sidebarOpen = false;
    this.viewerResized = false;

    if(this.settings.generatePagination) {
        book.generatePagination($viewer.width(), $viewer.height());
    }

    book.renderTo("viewer").then(function(_renderer) {
        this.renderer = renderer = _renderer;
        reader.StyleController = EPUBJS.reader.StylesController.call(reader,renderer);
    });

    reader.ReaderController = EPUBJS.reader.ReaderController.call(reader, book);
    reader.SettingsController = EPUBJS.reader.SettingsController.call(reader, book);
    reader.ControlsController = EPUBJS.reader.ControlsController.call(reader, book);
    reader.SidebarController = EPUBJS.reader.SidebarController.call(reader, book);
    // BookmarksController depends on NotesController so load NotesController first
    reader.NotesController = EPUBJS.reader.NotesController.call(reader, book);
    reader.BookmarksController = EPUBJS.reader.BookmarksController.call(reader, book);
    reader.SearchController = EPUBJS.reader.SearchController.call(reader, book);

    // Call Plugins
    for(plugin in EPUBJS.reader.plugins) {
        if(EPUBJS.reader.plugins.hasOwnProperty(plugin)) {
            reader[plugin] = EPUBJS.reader.plugins[plugin].call(reader, book);
        }
    }

    book.ready.all.then(function() {
        reader.ReaderController.hideLoader();
        if(reader.settings.session.cursor !== {}) {
            reader.trigger("reader:gotobookmark", reader.settings.session.cursor);
        }
    });

    book.getMetadata().then(function(meta) {
        reader.MetaController = EPUBJS.reader.MetaController.call(reader, meta);
    });

    book.getToc().then(function(toc) {
        reader.TocController = EPUBJS.reader.TocController.call(reader, toc);
    });

    window.addEventListener("beforeunload", this.unload.bind(this), false);

    window.addEventListener("hashchange", this.hashChanged.bind(this), false);

    book.on("renderer:keydown", reader.ReaderController.keyCommands.bind(this));

    book.on("renderer:selected", this.selectedRange.bind(this));


    return this;
};


// Annotations - bookmarks and notes
EPUBJS.Reader.prototype.cfiToId = function(cfi) {
    return cfi.replace(/\W/g, '');
};

EPUBJS.Reader.prototype.getBookmark = function (cfi) {
    var id = this.cfiToId(cfi);

    return this.settings.annotations[id];
};

EPUBJS.Reader.prototype.addBookmark = function(cfi) {
    var id = this.cfiToId(cfi),
        epubcfi = new EPUBJS.EpubCFI();

    var textContent = "",
        textOffset,
        text,
        range,
        bookmark;

    range = epubcfi.generateRangeFromCfi(cfi, this.book.renderer.doc);
    textOffset = range.startOffset;
    textContent = range.startContainer.wholeText;

    // use text snippet as bookmark text when text is available, otherwise use CFI
    if (!(/\S/.test(textContent))) {
        text = cfi;
    }  else {
        if (textOffset > 0 && textContent.charAt(textOffset-1) != " ") {
            text = EPUBJS.core.ellipsize(textContent.substr(textContent.indexOf(" ", textOffset)));
        } else {
            text = EPUBJS.core.ellipsize(textContent.substr(textOffset));
        }
    }

    // While this should not happen, check whether this page is already bookmarked,
    // if so, update existing bookmark
    if (this.isBookmarked(id)) {
        bookmark = this.getAnnotation(id);
        this.updateAnnotation(bookmark);
    } else {
        bookmark = new this.Annotation("bookmark", cfi, text, this.cfiToId(cfi));
        this.addAnnotation(bookmark);
    }

    this.trigger("reader:bookmarkcreated", bookmark);

    return bookmark;
};

EPUBJS.Reader.prototype.updateBookmark = function (bookmark) {
    this.updateAnnotation(bookmark);
};

EPUBJS.Reader.prototype.removeBookmark = function (cfi) {
    var id = this.cfiToId(cfi);
    this.removeAnnotation(id);
};

EPUBJS.Reader.prototype.isBookmarked = function (cfi) {
    var id = this.cfiToId(cfi);
    return (this.settings.annotations[id] !== undefined);
};

EPUBJS.Reader.prototype.clearBookmarks = function () {
    this.clearAnnotations("bookmark");
};

EPUBJS.Reader.prototype.getAnnotation = function (id) {
    return this.settings.annotations[id];
};

EPUBJS.Reader.prototype.addAnnotation = function (note) {
    this.settings.annotations[note.id] = note;
    this.settings.session.setBookmark(note.id, note.anchor, note.type, note);
};

EPUBJS.Reader.prototype.removeAnnotation = function (id) {
    if (this.settings.annotations[id] !== undefined) {
        var type = this.settings.annotations[id].type;
        this.trigger("reader:" + type + "removed", id);
        this.settings.session.deleteBookmark(id);
        delete this.settings.annotations[id];
    }
};

EPUBJS.Reader.prototype.updateAnnotation = function (note) {
    note.edited = Date.now();
    this.settings.annotations[note.id] = note;
    this.settings.session.setBookmark(note.id, note.anchor, note.type, note);
};


EPUBJS.Reader.prototype.clearAnnotations = function(type) {
    if (type) {
        for (var id in this.settings.annotations) {
            if (this.settings.annotations.hasOwnProperty(id) && this.settings.annotations[id].type === type) {
                this.trigger("reader:" + type + "removed", id);
                this.settings.session.deleteBookmark(id);
                delete this.settings.annotations[id];
            }
        }
    }
};

// Styles
EPUBJS.Reader.prototype.addStyleSheet = function (_id, _parentNode) {

    var id = _id,
        parentNode = _parentNode || document.head,
        style = document.createElement("style");

    // WebKit hack
    style.appendChild(document.createTextNode(""));
    style.setAttribute("id", id);
    parentNode.appendChild(style);
    return style.sheet;
};

EPUBJS.Reader.prototype.getStyleSheet = function (id, _parentNode) {

    if (id !== undefined) {
        var parentNode = _parentNode || document.head;
        var style = $(parentNode).find("style#" + id);

        if (style.length) return style[0];
    }
};
EPUBJS.Reader.prototype.addCSSRule = function (sheet, selector, rules, index) {

    if (index === undefined) index = 0;

    if("insertRule" in sheet) {
        sheet.insertRule(selector + "{" + rules + "}", index);
    } else if ("addRule" in sheet) {
        sheet.addRule(selector, rules, index);
    }
};

EPUBJS.Reader.prototype.addStyle = function (name, selector, rules, extra) {
    if (undefined === this.settings.customStyles[name]) {
        this.settings.customStyles[name] = new this.Style(name, selector, rules, extra);
        this.settings.session.setDefault("customStyles",this.settings.customStyles);
    }
};

EPUBJS.Reader.prototype.enableStyle = function (style) {

    var currentMain = this.getStyleSheet(style.name, document.head);
    var currentBook = this.getStyleSheet(style.name, renderer.doc.head);

    if (currentBook) $(currentBook).remove();
    if (currentMain) $(currentMain).remove();

    var rules = "",
        sheetBook = this.addStyleSheet(style.name, renderer.doc.head),
        sheetMain = this.addStyleSheet(style.name, document.head);

    for (var clause in style.rules) {
        rules += clause + ":" + style.rules[clause] + "!important;";
    }

    this.addCSSRule(sheetBook, style.selector, rules, 0);
    this.addCSSRule(sheetMain, (style.selector === "*") ? "#main" : style.selector, rules, 0);
    this.settings.activeStyles[style.name] = true;

    this.settings.session.setDefault("activeStyles", this.settings.activeStyles);
};

EPUBJS.Reader.prototype.disableStyle = function (style) {

    var currentMain = this.getStyleSheet(style.name, document.head);
    var currentBook = this.getStyleSheet(style.name, renderer.doc.head);

    if (currentBook) $(currentBook).remove();
    if (currentMain) $(currentMain).remove();
    if (this.settings.activeStyles[style.name]) {
        delete this.settings.activeStyles[style.name];
        this.settings.session.setDefault("activeStyles", this.settings.activeStyles);
    }
};

EPUBJS.Reader.prototype.updateStyle = function (style) {

    var current = this.getStyleSheet(style.name, renderer.doc.head);

    this.settings.session.setDefault("customStyles",this.settings.customStyles);

    if (current) this.enableStyle(style);
};

EPUBJS.Reader.prototype.deleteStyle = function (style) {
    this.disableStyle(style);
    delete this.customStyles[style.name];
    this.settings.session.setDefault("customStyles",this.settings.customStyles);
};

EPUBJS.Reader.prototype.refreshStyles = function (callback, renderer) {

    var activeStyles = this.settings.activeStyles,
        customStyles = this.settings.customStyles;

    for (var style in activeStyles) {
        if (!activeStyles.hasOwnProperty(style)) continue;

        var rules = "",
            sheet = this.addStyleSheet(style, renderer.doc.head);

        for (var clause in customStyles[style].rules) {
            if (!customStyles[style].rules.hasOwnProperty(clause)) continue;
            rules += clause + ":" + customStyles[style].rules[clause] + "!important;";
        }

        this.addCSSRule(sheet, customStyles[style].selector, rules, 0);
    }

    if (callback) callback();
};

// Defaults and Preferences
// Preferences are per-book settings and can override defaults
EPUBJS.Reader.prototype.restoreDefaults = function (defaults) {
    for (var i=0; i < defaults.length; i++) {
        this.settings[defaults[i].name] = defaults[i].value;
    }
};

EPUBJS.Reader.prototype.restorePreferences = function (preferences) {
    for (var i=0; i < preferences.length; i++) {
        this.settings[preferences[i].name] = preferences[i].value;
    }
};

EPUBJS.Reader.prototype.restoreAnnotations = function (annotations) {
    if (annotations !== {}) {
        for (var note in this.settings.session.annotations) {
            if (annotations.hasOwnProperty(note) && annotations[note].content !== null) {
                this.settings.annotations[annotations[note].name] = annotations[note].content;
            }
        }
    }
};

EPUBJS.Reader.prototype.unload = function (){
    console.log("unload");
    // nothing for now
};


EPUBJS.Reader.prototype.hashChanged = function(){
    var hash = window.location.hash.slice(1);
    this.book.goto(hash);
};

EPUBJS.Reader.prototype.selectedRange = function(range){
    if (range.anchorNode !== null) {
        var epubcfi = new EPUBJS.EpubCFI();
        var cfi = epubcfi.generateCfiFromRangeAnchor(range, this.book.renderer.currentChapter.cfiBase);
        var cfiFragment = "#"+cfi;

        // Update the History Location
        if(this.settings.history &&
            window.location.hash != cfiFragment) {
                // Add CFI fragment to the history
                history.pushState({}, '', cfiFragment);
                this.currentLocationCfi = cfi;
            }
    }
};

//-- Enable binding events to reader
RSVP.EventTarget.mixin(EPUBJS.Reader.prototype);

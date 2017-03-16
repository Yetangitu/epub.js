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

    console
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

EPUBJS.reader.BookmarksController = function() {

	var reader = this,
	    book = this.book,
        annotations = reader.settings.annotations;

	var $bookmarks = $("#bookmarksView"),
        $list = $bookmarks.find("#bookmarks"),
        $bookmark = $("#bookmark");
	
	var show = function() {
        $bookmarks.addClass('open');
	};

	var hide = function() {
        $bookmarks.removeClass('open');
	};

    var addBookmarkItem = function (bookmark) {
        $list.append(reader.NotesController.createItem(bookmark));
    };

    for (var bookmark in annotations) {
        if (annotations.hasOwnProperty(bookmark) && (annotations[bookmark].type === "bookmark"))
            addBookmarkItem(annotations[bookmark]);
	};
	
	this.on("reader:bookmarkcreated", function (bookmark) {
        addBookmarkItem(bookmark);
	});
	
	this.on("reader:bookmarkremoved", function (id) {
		var $item = $("#"+id),
            cfi = reader.book.getCurrentLocationCfi(),
            cfi_id = reader.cfiToId(cfi);

		$item.remove();

        if(cfi_id === id) {
            $bookmark
                .removeClass("icon-turned_in")
                .addClass("icon-turned_in_not");
        }
	});

    this.on("reader:gotobookmark", function (bookmark) {
        if (bookmark && bookmark.value)
            book.gotoCfi(bookmark.value);
    });

	return {
		"show" : show,
		"hide" : hide
	};
};

EPUBJS.reader.ControlsController = function(book) {
    var reader = this;

    var $store = $("#store"),
        $fullscreen = $("#fullscreen"),
        $fullscreenicon = $("#fullscreenicon"),
        $cancelfullscreenicon = $("#cancelfullscreenicon"),
        $slider = $("#slider"),
        $main = $("#main"),
        $sidebar = $("#sidebar"),
        $settings = $("#setting"),
        $bookmark = $("#bookmark"),
        $note = $("#note");

    var goOnline = function() {
        reader.offline = false;
        // $store.attr("src", $icon.data("save"));
    };

    var goOffline = function() {
        reader.offline = true;
        // $store.attr("src", $icon.data("saved"));
    };

    var fullscreen = false;

    book.on("book:online", goOnline);
    book.on("book:offline", goOffline);

    $slider.on("click", function () {
        if(reader.sidebarOpen) {
            reader.SidebarController.hide();
            //$slider.addClass("icon-menu");
            //$slider.removeClass("icon-right2");
        } else {
            reader.SidebarController.show();
            //$slider.addClass("icon-right2");
            //$slider.removeClass("icon-menu");
        }
    });

    if(typeof screenfull !== 'undefined') {
        $fullscreen.on("click", function() {
            screenfull.toggle($('#container')[0]);
        });
        if(screenfull.raw) {
            document.addEventListener(screenfull.raw.fullscreenchange, function() {
                fullscreen = screenfull.isFullscreen;
                if(fullscreen) {
                    $fullscreen
                        .addClass("icon-fullscreen_exit")
                        .removeClass("icon-fullscreen");
                } else {
                    $fullscreen
                        .addClass("icon-fullscreen")
                        .removeClass("icon-fullscreen_exit");
                }
            });
        }
    }

    $settings.on("click", function() {
        reader.SettingsController.show();
    });

    $note.on("click", function() {
        reader.SidebarController.changePanelTo("Notes");
    });

    $bookmark.on("click", function() {
        var cfi = reader.book.getCurrentLocationCfi();

        if(!(reader.isBookmarked(cfi))) { //-- Add bookmark
            reader.addBookmark(cfi);
            $bookmark
                .addClass("icon-turned_in")
                .removeClass("icon-turned_in_not");
        } else { //-- Remove Bookmark
            reader.removeBookmark(cfi);
            $bookmark
                .removeClass("icon-turned_in")
                .addClass("icon-turned_in_not");
        }

    });

    book.on('renderer:locationChanged', function(cfi){
        var cfiFragment = "#" + cfi;
        // save current position (cursor)
        reader.settings.session.setCursor(cfi);
        //-- Check if bookmarked
        if(!(reader.isBookmarked(cfi))) { //-- Not bookmarked
            $bookmark
                .removeClass("icon-turned_in")
                .addClass("icon-turned_in_not");
        } else { //-- Bookmarked
            $bookmark
                .addClass("icon-turned_in")
                .removeClass("icon-turned_in_not");
        }

        reader.currentLocationCfi = cfi;

        // Update the History Location
        if(reader.settings.history &&
            window.location.hash != cfiFragment) {
                // Add CFI fragment to the history
                history.pushState({}, '', cfiFragment);
            }
    });

    book.on('book:pageChanged', function(location){
        console.log("page", location.page, location.percentage)
    });

    return {

    };
};

EPUBJS.reader.MetaController = function(meta) {
	var title = meta.bookTitle,
			author = meta.creator;

	var $title = $("#book-title"),
			$author = $("#chapter-title"),
			$dash = $("#title-seperator");

		document.title = title+" – "+author;

		$title.html(title);
		$author.html(author);
		$dash.show();
};
EPUBJS.reader.NotesController = function() {

    var book = this.book,
        reader = this,
        $notesView = $("#notesView"),
        $notes = $("#notes"),
        $text = $("#note-text"),
        $anchor = $("#note-anchor"),
        $next = $("#next"),
        $prev = $("#prev"),
        $touch_nav = $("#touch_nav"),
        annotations = reader.settings.annotations,
        renderer = book.renderer,
        popups = [],
        epubcfi = new EPUBJS.EpubCFI();

    var show = function() {
        $notesView.addClass('open');
        $text.focus();
    };

    var hide = function() {
        $notesView.removeClass('open');
    };

    $text.on("keydown", function(e) {
        e.stopPropagation();
    });

    var insertAtPoint = function(e) {
        var range,
            textNode,
            offset,
            doc = book.renderer.doc,
            cfi,
            annotation;

        // standard
        if (doc.caretPositionFromPoint) {
            range = doc.caretPositionFromPoint(e.clientX, e.clientY);
            textNode = range.offsetNode;
            offset = range.offset;
        // WebKit
        } else if (doc.caretRangeFromPoint) {
            range = doc.caretRangeFromPoint(e.clientX, e.clientY);
            textNode = range.startContainer;
            offset = range.startOffset;
        }

        if (textNode.nodeType !== 3) {
            for (var i=0; i < textNode.childNodes.length; i++) {
                if (textNode.childNodes[i].nodeType == 3) {
                    textNode = textNode.childNodes[i];
                    break;
                }
            }
        }

        // Find the end of the sentence
        offset = textNode.textContent.indexOf(".", offset);
        if(offset === -1){
            offset = textNode.length; // Last item
        } else {
            offset += 1; // After the period
        }

        cfi = epubcfi.generateCfiFromTextNode(textNode, offset, book.renderer.currentChapter.cfiBase);

        annotation = new reader.Annotation('annotation', cfi, $text.val());

        // save...
        reader.addAnnotation(annotation);

        // show...
        addAnnotationItem(annotation);
        // add marker...
        placeMarker(annotation);

        // clear entry
        $text.val('');
        $anchor.removeClass("icon-location_off");
        $anchor.addClass("icon-room");
        $text.prop("disabled", false);

        book.off("renderer:click", insertAtPoint);
    };

    var addAnnotationItem = function(annotation) {
        $notes.append(createItem(annotation));
    };

    var deleteAnnotationItem = function (id) {
        var marker = book.renderer.doc.getElementById("note-" + id);
        var item = document.getElementById(id);

        if (item)
            item.remove();

        if (marker) {
            marker.remove();
            renumberMarkers();
        }
    };

    /* items are HTML-representations of annotations */
        var createItem = function(annotation){
            var item = document.createElement("li");
            var text = document.createElement("div");
            var date = document.createElement("div");
            var edit = document.createElement("span");
            var del = document.createElement("span");
            var link = document.createElement("a");
            var div = document.createElement("div");
            var save = document.createElement("span");
            var cancel = document.createElement("span");

            text.textContent = annotation.body;
            date.textContent = new Date(annotation.edited).toUTCString();
            item.classList.add("note");
            del.classList.add("item-delete", "item-control", "icon-delete");
            edit.classList.add("item-edit", "item-control", "icon-rate_review");
            link.classList.add("note-link", "icon-link2");
            date.classList.add("item-date");
            del.setAttribute("title",  "delete");
            edit.setAttribute("title", "edit");
            link.setAttribute("title", "context");
            item.setAttribute("id", annotation.id);
            save.classList.add("item-save", "edit-control", "hide", "icon-check");
            cancel.classList.add("item-cancel", "edit-control", "hide", "icon-close");
            save.setAttribute("display", "none");
            cancel.setAttribute("display", "none");

            link.href = "#"+annotation.anchor;

            link.onclick = function(){
                book.gotoCfi(annotation.anchor);
                return false;
            };

            del.onclick = function() {
                var id = this.parentNode.parentNode.getAttribute("id");
                //var marker = book.renderer.doc.getElementById("note-" + id);
                // remove note from collection...
                //reader.removeAnnotation(id);
                // ... and remove the marker...
                //if (marker) {
                    //    marker.remove();
                    //    renumberMarkers();
                    //}
                // ...and finally remove the HTML representation
                //this.parentNode.parentNode.remove();
                //renumberMarkers();
                reader.removeAnnotation(id);
            };

            save.onclick = function() {
                var id = this.parentNode.parentNode.getAttribute("id");
                var annotation = annotations[id];
                var text = this.parentNode.parentNode.firstChild;
                try {
                    annotation.body = text.textContent;
                    reader.updateAnnotation(annotation);
                } catch (e) {
                    console.log("Updating annotation failed: " + e);
                }
                closeEditor(id);
            };

            cancel.onclick = function () {
                var id = this.parentNode.parentNode.getAttribute("id");
                var text = this.parentNode.parentNode.firstChild;
                text.textContent = annotations[id].body;
                closeEditor(id);
            };

            edit.onclick = function() {
                openEditor(this.parentNode.parentNode.getAttribute("id"));
            };

            div.appendChild(cancel);
            div.appendChild(save);
            div.appendChild(del);
            div.appendChild(edit);
            div.appendChild(link);
            item.appendChild(text);
            item.appendChild(date);
            item.appendChild(div);
            return item;
        };

    var editAnnotation = function (e) {
        var text = e.target;
        var id = text.parentNode.getAttribute("id");
        if (e.keyCode === 27) { // escape - cancel editor, discard changes
            text.textContent = annotations[id].body;
            closeEditor(id);
        }
        e.stopPropagation();
    };

    var openEditor = function(id) {
        var item = document.getElementById(id);
        var text = item.firstChild;
        $(item).find(".item-control").toggleClass("hide");
        $(item).find(".edit-control").toggleClass("hide");
        text.setAttribute("contenteditable", "true");
        text.classList.add("editable");
        text.addEventListener("keydown", editAnnotation, false);
    };

    var closeEditor = function (id) {
        var item = document.getElementById(id);
        var text = item.firstChild;
        $(item).find(".item-control").toggleClass("hide");
        $(item).find(".edit-control").toggleClass("hide");
        text.classList.remove("editable");
        text.removeAttribute("contenteditable");
        text.removeEventListener("keydown", editAnnotation, false);
    };

    var findIndex = function (id) {
        // list has items
        var i,
            list = $notes[0].getElementsByTagName("li");

        for (i = 0; i < list.length; i++) {
            if (list[i].getAttribute("id") === id)
                break;
        }

        return i+1;
    };

    var placeMarker = function(annotation){
        var doc = book.renderer.doc,
            marker = document.createElement("span"),
            mark = document.createElement("a");

        marker.classList.add("note-marker", "footnotesuperscript", "reader_generated");
        marker.id = "note-" + annotation.id;
        mark.innerHTML = findIndex(annotation.id) + "[Reader]";

        marker.appendChild(mark);
        epubcfi.addMarker(annotation.anchor, doc, marker);

        markerEvents(marker, annotation.body);
        renumberMarkers();
    }

    var renumberMarkers = function() {
        for (var note in annotations) {
            if (annotations.hasOwnProperty(note)) {
                var chapter = renderer.currentChapter;
                var cfi = epubcfi.parse(annotations[note].anchor);
                if(cfi.spinePos === chapter.spinePos) {
                    try {
                        var marker = book.renderer.doc.getElementById("note-" + annotations[note].id);
                        if (marker !== undefined) {
                            marker.innerHTML = findIndex(annotations[note].id) + "[Reader]";
                        }
                    } catch(e) {
                        console.log("renumbering of markers failed", annotations[note].anchor);
                    }
                }
            }
        };
    };

    var markerEvents = function(item, txt){
        var id = item.id;

        var showPop = function(){
            var poppos,
                iheight = renderer.height,
                iwidth = renderer.width,
                tip,
                pop,
                maxHeight = 225,
                itemRect,
                left,
                top,
                pos;


            //-- create a popup with endnote inside of it
            if(!popups[id]) {
                popups[id] = document.createElement("div");
                popups[id].setAttribute("class", "popup");

                pop_content = document.createElement("div"); 

                popups[id].appendChild(pop_content);

                pop_content.innerHTML = txt;
                pop_content.setAttribute("class", "pop_content");

                renderer.render.document.body.appendChild(popups[id]);

                //-- TODO: will these leak memory? - Fred 
                popups[id].addEventListener("mouseover", onPop, false);
                popups[id].addEventListener("mouseout", offPop, false);

                //-- Add hide on page change
                renderer.on("renderer:locationChanged", hidePop, this);
                renderer.on("renderer:locationChanged", offPop, this);
                // chapter.book.on("renderer:chapterDestroy", hidePop, this);
            }

            pop = popups[id];


            //-- get location of item
            itemRect = item.getBoundingClientRect();
            left = itemRect.left;
            top = itemRect.top;

            //-- show the popup
            pop.classList.add("show");

            //-- locations of popup
            popRect = pop.getBoundingClientRect();

            //-- position the popup
            pop.style.left = left - popRect.width / 2 + "px";
            pop.style.top = top + "px";


            //-- Adjust max height
            if(maxHeight > iheight / 2.5) {
                maxHeight = iheight / 2.5;
                pop_content.style.maxHeight = maxHeight + "px";
            }

            //-- switch above / below
            if(popRect.height + top >= iheight - 25) {
                pop.style.top = top - popRect.height  + "px";
                pop.classList.add("above");
            }else{
                pop.classList.remove("above");
            }

            //-- switch left
            if(left - popRect.width <= 0) {
                pop.style.left = left + "px";
                pop.classList.add("left");
            }else{
                pop.classList.remove("left");
            }

            //-- switch right
            if(left + popRect.width / 2 >= iwidth) {
                //-- TEMP MOVE: 300
                pop.style.left = left - 300 + "px";

                popRect = pop.getBoundingClientRect();
                pop.style.left = left - popRect.width + "px";
                //-- switch above / below again
                if(popRect.height + top >= iheight - 25) { 
                    pop.style.top = top - popRect.height  + "px";
                    pop.classList.add("above");
                }else{
                    pop.classList.remove("above");
                }

                pop.classList.add("right");
            }else{
                pop.classList.remove("right");
            }

        }

        var onPop = function(){
            popups[id].classList.add("on");
        }

        var offPop = function(){
            popups[id].classList.remove("on");
        }

        var hidePop = function(){
            setTimeout(function(){
                popups[id].classList.remove("show");
            }, 100);	
        }

        var openSidebar = function(){
            reader.SidebarController.changePanelTo('Notes');
            reader.SidebarController.show();
        };

        item.addEventListener("mouseover", showPop, false);
        item.addEventListener("mouseout", hidePop, false);
        item.addEventListener("click", openSidebar, false);

    }

    $anchor.on("click", function(e){
        if ($anchor[0].classList.contains("icon-room")) {
            $anchor.removeClass("icon-room");
            $anchor.addClass("icon-location_off");
            $text.prop("disabled", true);
            // disable extra-wide navigation as it interferes with anchor placment
            if ($prev.hasClass("touch_nav")) {
                $prev.removeClass("touch_nav");
                $next.removeClass("touch_nav");
                $prev.addClass("restore_touch_nav");
            }
            // listen for selection
            book.on("renderer:click", insertAtPoint);
        } else {
            $text.prop("disabled", false);
            $anchor.removeClass("icon-location_off");
            $anchor.addClass("icon-room");
            if ($prev.hasClass("restore_touch_nav")) {
                $prev.removeClass("restore_touch_nav");
                $prev.addClass("touch_nav");
                $next.addClass("touch_nav");
            }
            book.off("renderer:click", insertAtPoint);
        }
    });

    for (var note in annotations) {
        if (annotations.hasOwnProperty(note) && (annotations[note].type === "annotation"))
            addAnnotationItem(annotations[note]);
    };

    this.on("reader:annotationcreated", function (note) {
        addAnnotationItem(note);
    });

    this.on("reader:annotationremoved", function (id) {
        deleteAnnotationItem(id);
    });

    // replace markers for annotations
    renderer.registerHook("beforeChapterDisplay", function(callback, renderer){
        var chapter = renderer.currentChapter;
        for (var note in annotations) {
            if (annotations.hasOwnProperty(note) && (annotations[note].type === "annotation")) {
                var cfi = epubcfi.parse(annotations[note].anchor);
                if(cfi.spinePos === chapter.spinePos) {
                    try {
                        placeMarker(annotations[note]);
                    } catch(e) {
                        console.log("anchoring failed", annotations[note].anchor);
                    }
                }
            }
        };
        callback();
    }, true);


    return {
        "show" : show,
        "hide" : hide,
        "createItem": createItem
    };
};

EPUBJS.reader.ReaderController = function(book) {
    var $main = $("#main"),
        $divider = $("#divider"),
        $loader = $("#loader"),
        $next = $("#next"),
        $prev = $("#prev"),
        $sidebarReflow = $('#sidebarReflow'),
        $metainfo = $("#metainfo"),
        $use_custom_colors = $("#use_custom_colors"),
        $container = $("#container"),
        $fullscreen = $("#fullscreen"),
        $bookmark = $("#bookmark"),
        $note = $("#note");

    var reader = this,
        book = this.book,
        settings = reader.settings;

    var slideIn = function() {
        if (reader.viewerResized) {
            var currentPosition = book.getCurrentLocationCfi();
            reader.viewerResized = false;
            $main.removeClass('single');
            $main.one("transitionend", function(){
                book.gotoCfi(currentPosition);
            });
        }
    };

    var slideOut = function() {
        var currentPosition = book.getCurrentLocationCfi();
        reader.viewerResized = true;
        $main.addClass('single');
        $main.one("transitionend", function(){
            book.gotoCfi(currentPosition);
        });
    };

    var showLoader = function() {
        $loader.show();
        hideDivider();
    };

    var hideLoader = function() {
        $loader.hide();

        //-- If the book is using spreads, show the divider
        // if(book.settings.spreads) {
            // 	showDivider();
            // }
    };

    var showDivider = function() {
        $divider.addClass("show");
    };

    var hideDivider = function() {
        $divider.removeClass("show");
    };

    var keylock = false;

    var showActive = function (obj) {
        keylock = true;
        obj.addClass("active");	
        setTimeout(function () {
            keylock = false;
            obj.removeClass("active");
        }, 100);
    };

    var keyCommands = function(e) {

        var page_no = false;

        switch (settings.keyboard[e.keyCode]) {
            case 'previous':
                $prev.click();
                break;
            case 'next':
                $next.click();
                break;
            case 'first':
                page_no = 1;
                break;
            case 'last':
                // TODO
                break;
            case 'annotate':
                $note.click();
                break;
            case 'bookmark':
                $bookmark.click();
                break;
            case 'reflow':
                $sidebarReflow.click();
                break;
            case 'toggleSidebar':
                reader.SidebarController.toggle();
                break;
            case 'closeSidebar':
                reader.SidebarController.hide();
                break;
            case 'toggleFullscreen':
                $fullscreen.click();
                break;
            case 'toggleNight':
                $metainfo.click();
                break;
            case 'toggleDay':
                $use_custom_colors.click();
                break;
            default:
                console.log("unsupported keyCode: " + e.keyCode);
        }

        if (page_no) {

            // TODO
        }
    }

    document.addEventListener('keydown', keyCommands, false);

    $next.on("click", function(e){

        if(book.metadata.direction === "rtl") {
            book.prevPage();
        } else {
            book.nextPage();
        }

        showActive($next);

        e.preventDefault();
    });

    $prev.on("click", function(e){

        if(book.metadata.direction === "rtl") {
            book.nextPage();
        } else {
            book.prevPage();
        }

        showActive($prev);

        e.preventDefault();
    });

    book.on("renderer:spreads", function(bool){
        if(bool) {
            showDivider();
        } else {
            hideDivider();
        }
    });

    // book.on("book:atStart", function(){
        // 	$prev.addClass("disabled");
        // });
    // 
    // book.on("book:atEnd", function(){
        // 	$next.addClass("disabled");	
        // });

    return {
        "slideOut" : slideOut,
        "slideIn"  : slideIn,
        "showLoader" : showLoader,
        "hideLoader" : hideLoader,
        "showDivider" : showDivider,
        "hideDivider" : hideDivider,
        "keyCommands" : keyCommands
    };
};

EPUBJS.reader.SearchController = function () {
    var reader = this,
        book = this.book,
        query = "";

    var $searchBox = $("#searchBox"),
        $clearBtn = $("#searchBox").next(),
        $clear_search = $("#clear_search"), 
        $searchResults = $("#searchResults"),
        $searchView = $("#searchView"),
        $body = $("#viewer iframe").contents().find('body'),
        $sidebar = $("#sidebar");

    var onShow = function() {
        $searchView.addClass("open");
        $searchBox.focus();
    };

    var onHide = function() {
        unhighlight();
        $searchView.removeClass("open");
    };

    var search = function(q) {
        if (q === undefined) {
            q = $searchBox.val();
        }

        if (q == '') {
            clear();
            return;
        }

        reader.SidebarController.changePanelTo("Search");

        $searchResults.empty();
        $searchResults.append("<li><p>Searching...</p></li>");

        reader.SearchController.query = q;

        runQuery(q, $searchResults[0]);

    };

    $searchBox.on("keydown", function(e) {
        // Show the clear button if text input value is not empty
        $clearBtn.css("visibility", (this.value.length) ? "visible" : "hidden");

        // run search when Enter is pressed
        if (e.keyCode === 13) {
            search();
        }

        e.stopPropagation();
    });

    $clearBtn.on("click", function() {
        $(this).css("visibility", "hidden");
        $searchBox.val("");
    });

    $clear_search.on("click", function () {
        unhighlight();
        $searchResults.empty();
    });

    var clear = function () {

        unhighlight();
        $searchResults.empty();

        if (reader.SidebarController.getActivePanel() == "Search") {
            reader.SidebarController.changePanelTo("Toc");
        }
    };

    var highlightQuery = function(e) {
        $("#viewer iframe").contents().find('body').highlight(reader.SearchController.query, { element: 'span' });
    };

    var unhighlight = function(e) {
        $body = $("#viewer iframe").contents().find('body');
        $body.unhighlight();
        book.off("renderer:chapterDisplayed", highlightQuery);
    };

    // perform search and build result list
    var runQuery = function(query, element) {

        return new Promise(function(resolve, reject) {

            var results = [];

            for (var i = 0; i < book.spine.length; i++) {
                var spineItem = book.spine[i];
                results.push(new Promise(function(resolve, reject) {
                    new Promise(function(resolve, reject) {
                        resolve(new EPUBJS.Chapter(spineItem, book.store, book.credentials));
                    }).then(function(chapter) {
                        return new Promise(function(resolve, reject) {
                            chapter.load().then(function() {
                                resolve(chapter);
                            }).catch(reject);
                        });
                    }).then(function(chapter) {
                        return Promise.resolve(chapter.find(query));
                    }).then(function(result) {
                        resolve(result);
                    });
                }));
            }
            Promise.all(results).then(function(results) {
                return new Promise(function(resolve, reject) {
                    resolve(results);
                    var mergedResults = [].concat.apply([], results);
                    element.innerHTML = "";
                    for (var i = 0; i < mergedResults.length; i++) {
                        try {
                            var listitem = document.createElement("li");
                            var link = document.createElement("a");
                            listitem.classList.add("list_item");
                            listitem.id = "search-"+i;
                            link.href=mergedResults[i].cfi;
                            link.textContent = mergedResults[i].excerpt;
                            link.classList.add("toc_link");
                            link.addEventListener("click", function(e) {
                                e.preventDefault();
                                book.gotoCfi(this.getAttribute("href"));
                                $searchResults.find(".list_item")
                                    .removeClass("currentChapter");
                                $(this).parent("li").addClass("currentChapter");
                                $(this).data('query', query);
                                book.on("renderer:chapterDisplayed", highlightQuery);
                            });
                            listitem.appendChild(link);
                            element.appendChild(listitem);
                        } catch (e) {
                            console.warn(e);
                        }
                    }
                });
            });
        });
    };


    return {
        "show"  : onShow,
        "hide"  : onHide,
        "search": search,
        "query" : query,
        "clear" : clear,
        "unhighlight"   : unhighlight
    };
};

EPUBJS.reader.SettingsController = function() {

	var reader = this,
		book = this.book,
		settings = reader.settings;

    var $settings = $("#settingsView"),
        $viewer = $("#viewer"),
		$overlay = $(".overlay"),
        $next = $("#next"),
        $prev = $("#prev"),
        $close = $("#close"),
        $sidebarReflow = $('#sidebarReflow'),
        $touch_nav = $("#touch_nav"),
        $page_turn_arrows = $("#page_turn_arrows"),
        $prev_arrow = $("#prev :first-child"),
        $next_arrow = $("#next :first-child");

	var show = function() {
        $settings.addClass('open');
	};

	var hide = function() {
        $settings.removeClass('open');
	};

    if (settings.sidebarReflow) {
        $sidebarReflow.prop('checked', true);
    } else {
        $sidebarReflow.prop('checked', false);
    }

	$sidebarReflow.off('click').on('click', function() {
		settings.sidebarReflow = !settings.sidebarReflow;
        if (settings.sidebarReflow && reader.sidebarOpen) reader.ReaderController.slideOut();
        if (!settings.sidebarReflow && !reader.sidebarOpen) reader.ReaderController.slideIn();
        settings.session.setDefault("sidebarReflow", settings.sidebarReflow);
	});

	$settings.find(".closer").on("click", function() {
		hide();
	});

	$overlay.on("click", function() {
		hide();
	});

    // only enable close button when launched in an iframe default
    if (parent !== window) {
        $close.show();
        $close.on("click", function () {
            reader.book.destroy();
            parent.OCA.Files_Reader.Plugin.hide();
        });
    }

    // default for extra wide navigation controls;
    //  devices with touch navigation: on
    //  devices without touch navigation: off
    $touch_nav.prop('checked', !('ontouchstart' in document.documentElement));
    if (!($touch_nav.prop('checked'))) {
        $next.addClass("touch_nav");
        $prev.addClass("touch_nav");
    }

    // extra wide nagivation controls
    $touch_nav.off('change').on('change', function() {
        if ($(this).prop('checked')) {
            $prev.removeClass("touch_nav");
            $next.removeClass("touch_nav");
        } else {
            $prev.addClass("touch_nav");
            $next.addClass("touch_nav");
        }
    });

    // page turn arrows default
    if (settings.pageArrows) {
        $page_turn_arrows.prop('checked', true);
        $prev_arrow.removeClass("translucent");
        $next_arrow.removeClass("translucent");
    } else {
        $page_turn_arrows.prop('checked', false);
        $prev_arrow.addClass("translucent");
        $next_arrow.addClass("translucent");
    }

    // page turn arrows
    $page_turn_arrows.off('change').on('change', function() {
        if ($(this).prop('checked')) {
            settings.pageArrows = true;
            $prev_arrow.removeClass("translucent");
            $next_arrow.removeClass("translucent");
        } else {
            settings.pageArrows = false;
            $prev_arrow.addClass("translucent");
            $next_arrow.addClass("translucent");
        }

        settings.session.setDefault("pageArrows", settings.pageArrows);
    });

	return {
		"show" : show,
		"hide" : hide
	};
};

EPUBJS.reader.SidebarController = function(book) {
    var reader = this,
        settings = reader.settings;

    var $sidebar = $("#sidebar"),
        $panels = $("#panels"),
        $views = $("#views"),
        $close = $("#hide-Sidebar");
    $slider = $("#slider");

    var activePanel = "Toc";

    var changePanelTo = function(viewName) {
        var controllerName = viewName + "Controller";

        if (!(activePanel == viewName || typeof reader[controllerName] === 'undefined' )) {
            reader[activePanel+ "Controller"].hide();
            reader[controllerName].show();
            activePanel = viewName;

            //$panels.find('.open').removeClass("open");
            $sidebar.find('.open').removeClass("open");
            $panels.find("#show-" + viewName ).addClass("open");
            $views.find("#" + viewName.toLowerCase() + "View").addClass("open");
        }
        show();
    };

    var getActivePanel = function() {
        return activePanel;
    };

    var show = function() {
        reader.sidebarOpen = true;
        if (settings.sidebarReflow) reader.ReaderController.slideOut();
        $slider.hide();
        $sidebar.addClass("open");
    }

    var hide = function() {
        reader.sidebarOpen = false;
        $slider.show();
        reader.ReaderController.slideIn();
        $sidebar.removeClass("open");
        reader.SearchController.unhighlight();
    };

    var toggle = function () {
        (reader.sidebarOpen) ? hide() : show();
    };

    $close.on("click", function () {
        reader.SidebarController.hide();
        // $slider.addClass("icon-menu");
        // $slider.removeClass("icon-right");

    });

    $panels.find(".show_view").on("click", function(e) {
        var view = $(this).data("view");

        changePanelTo(view);
        e.preventDefault();
    });

    return {
        'show' : show,
        'hide' : hide,
        'toggle' : toggle,
        'getActivePanel' : getActivePanel,
        'changePanelTo' : changePanelTo
    };
};

EPUBJS.reader.StylesController = function (renderer) {

    var reader = this,
        book = this.book,
		settings = reader.settings,
        customStyles = reader.settings.customStyles,
        activeStyles = reader.settings.activeStyles,
        $viewer = $("#viewer"),
        $day_example = $('#day_example'),
        $night_example = $('#night_example'),
        $font_example = $('#font_example'),
        $page_width = $("#page_width"),
        $day_background = $('#day_background'),
        $day_color = $('#day_color'),
        $night_background = $('#night_background'),
        $night_color = $('#night_color'),
        $use_custom_colors = $('#use_custom_colors'),
        $nightshift = $('.nightshift'),
        $custom_font_family = $('#custom_font_family'),
        $font_family = $('#font_family'),
        $custom_font_size = $('#custom_font_size'),
        $font_size = $("#font_size"),
        $custom_font_weight = $('#custom_font_weight'),
        $font_weight = $("#font_weight"),
        $maximize_page = $('#maximize_page');

    // register hook to refresh styles on chapter change    
    renderer.registerHook("beforeChapterDisplay", this.refreshStyles.bind(this), true);

    this.addStyle("dayMode", "*", {
        color: $day_color.val(),
        background: $day_background.val()
    });
    
    this.addStyle("nightMode", "*", {
        color: $night_color.val(),
        background: $night_background.val()
    });
    
    this.addStyle("fontFamily", "*", {
        "font-family": $font_family.val()
    });
    
    this.addStyle("fontSize", "*", {
        "font-size": $font_size.val() + '%'
    });

    this.addStyle("fontWeight", "*", {
        "font-weight": $font_weight.val()
    });

    this.addStyle("pageWidth", "#viewer", {
        "max-width": $page_width.val() + 'em'
    });

    this.addStyle("maximizePage", "#viewer", {
        "margin": "auto",
        "width": "100%",
        "height": "95%",
        "top": "5%"
    });

    this.addStyle("appleBugs", "document, html, body, p, span, div", {
        "cursor": "pointer"
    });

    $day_example.css({
        'background': customStyles.dayMode.rules.background,
        'color': customStyles.dayMode.rules.color
    });

    $night_example.css({
        'background': customStyles.nightMode.rules.background,
        'color': customStyles.nightMode.rules.color
    });

    $font_example.css({
        'font-size': customStyles.fontSize.rules["font-size"],
        'font-family': customStyles.fontFamily.rules["font-family"],
        'font-weight': customStyles.fontWeight.rules["font-weight"]
    });

    $font_family.val(customStyles.fontFamily.rules["font-family"]);
    $font_size.val(parseInt(customStyles.fontSize.rules["font-size"]));
    $font_weight.val(customStyles.fontWeight.rules["font-weight"]);
    $page_width.val(parseInt(0 + parseInt(customStyles.pageWidth.rules["max-width"])));

    // fix click-bug in apple products
    if (navigator.userAgent.match(/(iPad|iPhone|iPod)/g))
        activeStyles['appleBugs'] = true;

    for (var style in activeStyles) {
        if (!activeStyles.hasOwnProperty(style)) continue;

        switch (style) {
            case "dayMode":
                $use_custom_colors.prop("checked", true);
                break;
            case "fontFamily":
                $custom_font_family.prop("checked", true);
                $font_family.prop('disabled',false);
                break;
            case "fontSize":
                $custom_font_size.prop("checked", true);
                $font_size.prop('disabled',false);
                break;
            case "maximizePage":
                $maximize_page.prop("checked", true);
                break;
            case "appleBugs":
                console.log("Apple mobile bugs detected, applying workarounds...");
                break;
        }

        reader.enableStyle(customStyles[style]);
    }

    $day_background.off('change').on('change', function() {
        customStyles.dayMode.rules.background = $day_background.val();
        $day_example.css('background', customStyles.dayMode.rules.background);
        reader.updateStyle(customStyles.dayMode);
    });

    $day_color.off('change').on('change', function() {
        customStyles.dayMode.rules.color = $day_color.val();
        $day_example.css('color', customStyles.dayMode.rules.color);
        reader.updateStyle(customStyles.dayMode);
    });

    $night_background.off('change').on('change', function() {
        customStyles.nightMode.rules.background = $night_background.val();
        $night_example.css('background', customStyles.nightMode.rules.background);
        reader.updateStyle(customStyles.nightMode);
    });

    $night_color.off('change').on('change', function() {
        customStyles.nightMode.rules.color = $night_color.val();
        $night_example.css('color', customStyles.nightMode.rules.color);
        reader.updateStyle(customStyles.nightMode);
    });

    $use_custom_colors.off('change').on('change', function () {
        if ($(this).prop('checked')) {
            reader.enableStyle(customStyles.dayMode);
        } else {
            reader.disableStyle(customStyles.dayMode);
        }
    });

    $nightshift.off('click').on('click', function () {
        if (settings.nightMode) {
            reader.disableStyle(customStyles.nightMode);
            settings.nightMode = false;
        } else {
            reader.enableStyle(customStyles.nightMode);
            settings.nightMode = true;
        }
    });

    $page_width.off('change').on("change", function () {
        customStyles.pageWidth.rules["page-width"] = $(this).val() + "em";
		reader.updateStyle(customStyles.pageWidth);
        $viewer.css("max-width", customStyles.pageWidth.rules["page-width"]);
    });

    $custom_font_family.off('click').on('click', function() {
        if ($(this).prop('checked')) {
            $font_family.prop('disabled',false);
            reader.enableStyle(customStyles.fontFamily);
        } else {
            $font_family.prop('disabled',true);
            reader.disableStyle(customStyles.fontFamily);
        }
    });

    $custom_font_size.off('click').on('click', function() {
        if ($(this).prop('checked')) {
            $font_size.prop('disabled',false);
            reader.enableStyle(customStyles.fontSize);
        } else {
            $font_size.prop('disabled',true);
            reader.disableStyle(customStyles.fontSize);
        }
    });

    $custom_font_weight.off('click').on('click', function() {
        if ($(this).prop('checked')) {
            $font_weight.prop('disabled',false);
            reader.enableStyle(customStyles.fontWeight);
        } else {
            $font_weight.prop('disabled',true);
            reader.disableStyle(customStyles.fontWeight);
        }
   });

   $maximize_page.off('click').on('click', function() {
        if ($(this).prop('checked')) {
            reader.enableStyle(customStyles.maximizePage);
        } else {
            reader.disableStyle(customStyles.maximizePage);
        }
    });

    $font_size.off('change').on('change', function() {
        $font_example.css('font-size', $(this).val() + '%');
        customStyles.fontSize.rules["font-size"] = $(this).val() + '%';
        reader.updateStyle(customStyles.fontSize);
    });

    $font_weight.off('change').on('change', function() {
        customStyles.fontWeight.rules["font-weight"] = $(this).val();
        $font_example.css('font-weight', $(this).val());
        reader.updateStyle(customStyles.fontWeight);
    });

    $font_family.off('change').on('change', function() {
        customStyles.fontFamily.rules["font-family"] = $(this).val();
        $font_example.css('font-family', $(this).val());
        reader.updateStyle(customStyles.fontFamily);
    });

    $page_width.off('change').on("change", function () {
        customStyles.pageWidth.rules["page-width"] = $(this).val() + "em";
		reader.updateStyle(customStyles.pageWidth);
        $viewer.css("max-width", customStyles.pageWidth.rules["page-width"]);
    });

    return {
    };
};

EPUBJS.reader.TocController = function(toc) {
	var book = this.book;

	var $list = $("#tocView"),
			docfrag = document.createDocumentFragment();

	var currentChapter = false;

	var generateTocItems = function(toc, level) {
		var container = document.createElement("ul");

		if(!level) level = 1;

		toc.forEach(function(chapter) {
			var listitem = document.createElement("li"),
					link = document.createElement("a");
					toggle = document.createElement("a");

			var subitems;

			listitem.id = "toc-"+chapter.id;
			listitem.classList.add('list_item');

			link.textContent = chapter.label;
			link.href = chapter.href;

			link.classList.add('toc_link');

			listitem.appendChild(link);

			if(chapter.subitems.length > 0) {
				level++;
				subitems = generateTocItems(chapter.subitems, level);
				toggle.classList.add('toc_toggle');

				listitem.insertBefore(toggle, link);
				listitem.appendChild(subitems);
			}


			container.appendChild(listitem);

		});

		return container;
	};

	var onShow = function() {
        $list.addClass('open');
	};

	var onHide = function() {
        $list.removeClass('open');
	};

	var chapterChange = function(e) {
		var id = e.id,
				$item = $list.find("#toc-"+id),
				$current = $list.find(".currentChapter"),
				$open = $list.find('.openChapter');

		if($item.length){

			if($item != $current && $item.has(currentChapter).length > 0) {
				$current.removeClass("currentChapter");
			}

			$item.addClass("currentChapter");

			// $open.removeClass("openChapter");
			$item.parents('li').addClass("openChapter");
		}
	};

	book.on('renderer:chapterDisplayed', chapterChange);

	var tocitems = generateTocItems(toc);

	docfrag.appendChild(tocitems);

	$list.append(docfrag);
	$list.find(".toc_link").on("click", function(event){
			var url = this.getAttribute('href');

			event.preventDefault();

			//-- Provide the Book with the url to show
			//   The Url must be found in the books manifest
			book.goto(url);

			$list.find(".currentChapter")
					.addClass("openChapter")
					.removeClass("currentChapter");

			$(this).parent('li').addClass("currentChapter");

	});

	$list.find(".toc_toggle").on("click", function(event){
			var $el = $(this).parent('li'),
					open = $el.hasClass("openChapter");

			event.preventDefault();
			if(open){
				$el.removeClass("openChapter");
			} else {
				$el.addClass("openChapter");
			}
	});

	return {
		"show" : onShow,
		"hide" : onHide
	};
};

//# sourceMappingURL=reader.js.map
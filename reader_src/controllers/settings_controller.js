EPUBJS.reader.SettingsController = function() {
	var book = this.book;
	var reader = this;
	// var $settings = $("#settings-modal"),
    var $settings = $("#settingsView"),
			$overlay = $(".overlay");

	var show = function() {
		// $settings.addClass("md-show");
        $settings.addClass('open');
        // $settings.show();
	};

	var hide = function() {
		// $settings.removeClass("md-show");
        // $settings.hide();
        $settings.removeClass('open');
	};

	var $sidebarReflowSetting = $('#sidebarReflow');

	$sidebarReflowSetting.on('click', function() {
		reader.settings.sidebarReflow = !reader.settings.sidebarReflow;
	});

	$settings.find(".closer").on("click", function() {
		hide();
	});

	$overlay.on("click", function() {
		hide();
	});

	return {
		"show" : show,
		"hide" : hide
	};
};

module.exports = function(grunt) {

	grunt
			.initConfig({
				pkg : grunt.file.readJSON("package.json"),
				clean: ["output"],
				concat : {
					js : {
						files : {
							"output/js/bimviews.js" : [ 
							        "js/jquery-2.2.0.js", 
							        "js/bootstrap.min.js", 
							        "js/jquery.cookie.js", 
							        "js/jquery.dragbetter.js", 
							        "js/jquery.enterpress.js", 
							        "js/jquery.numeric.js", 
							        "js/jquery.scrollTo.js", 
							        "js/pagechanger.js", 
							        "js/papaparse.min.js", 
							        "js/prettify.js", 
							        "js/sha256.js", 
							        "js/String.js", 
							        "js/tree.js", 
							        "js/utils.js", 
							        "js/Variable.js", 
							        "js/vkbeautify.0.99.00.beta.js", 
							        "js/history.js", 
							        "js/history.adapter.jquery.js", 
							        "js/formatters.js", 
							        "js/EventRegistry.js", 
							        "js/consolesettings.js", 
							        "js/base64unicode.js", 
							        "js/main.js",
							        "js/plugins/*.js"]
						},
					}
				},
				uglify : {
					dist : {
						files : {
							"output/js/bimviews.min.js" : [ "output/js/bimviews.js" ]
						}
					}
				},
				cssmin : {
					options : {
						shorthandCompacting : false,
						roundingPrecision : -1
					},
					target : {
						files : {
							"output/css/bimviews.min.css" : [ "css/bootstrap.min.css", "css/main.css", "css/bootstrap-vert-tabs.css", "css/magic-bootstrap-min.css" ]
						}
					}
				},
				copy : {
					main : {
						files : [{
							expand : true,
							src : [ "fonts/**", "img/**" ],
							dest : "output/"
						}, {
							src: ["*.html"],
							dest: "output/"
						}, {
							src: ["plugin/**"],
							dest: "output/"
						}]
					}
				},
				zip: {
					"using-cwd": {
						cwd: "output",
						src: ["output/**"],
						dest: "output/bimviews-%VERSION%.zip"
					}
				}
			});

	grunt.loadNpmTasks("grunt-contrib-concat");
	grunt.loadNpmTasks("grunt-contrib-uglify");
	grunt.loadNpmTasks("grunt-contrib-cssmin");
	grunt.loadNpmTasks("grunt-contrib-copy");
	grunt.loadNpmTasks("grunt-contrib-clean");
	grunt.loadNpmTasks("grunt-zip");

	grunt.registerTask("default", [ "clean", "concat", "uglify", "cssmin", "copy" ]);
};
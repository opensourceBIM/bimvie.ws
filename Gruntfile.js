module.exports = function(grunt) {

	grunt
			.initConfig({
				pkg : grunt.file.readJSON("package.json"),
				clean: ["output"],
				concat : {
					js : {
						files : {
							"tmp/bimviews-%VERSION%.js" : [ "js/*.js", "node_modules/bimserverapi/*.js" ]
						},
					}
				},
				uglify : {
					dist : {
						files : {
							"output/js/bimviews.min.js" : [ "tmp/bimviews.js" ]
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
							"output/css/bimviews.min.css" : [ "css/*.css" ]
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
				},
				"github-release" : {
					options : {
						repository : "opensourceBIM/bimvie.ws",
						auth : {
							user : "%USERNAME%",
							password : "%PASSWORD%"
						},
						release : {
							tag_name : "%VERSION%",
							name : "BIMvie.ws %VERSION%",
							body : "Testing...",
							draft : false,
							prerelease : true
						}
					},
					files : {
						src : [ "output/bimviews-%VERSION%.zip",
								"output/bimviews-bimserver-plugin-%VERSION%.jar" ]
					}
				}
			});

	grunt.loadNpmTasks("grunt-github-releaser");
	grunt.loadNpmTasks("grunt-contrib-concat");
	grunt.loadNpmTasks("grunt-contrib-uglify");
	grunt.loadNpmTasks("grunt-contrib-cssmin");
	grunt.loadNpmTasks("grunt-contrib-copy");
	grunt.loadNpmTasks("grunt-contrib-clean");
	grunt.loadNpmTasks("grunt-zip");

	grunt.registerTask("default", [ "clean", "concat", "uglify", "cssmin", "copy", "zip", "github-release" ]);
};
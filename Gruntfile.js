module.exports = function(grunt) {

	grunt
			.initConfig({
				pkg : grunt.file.readJSON("package.json"),
				concat : {
					js : {
						files : {
							"output/bimviews-%VERSION%.js" : [ "js/*.js" ]
						},
					}
				},
				uglify : {
					dist : {
						files : {
							"output/bimviews-%VERSION%.min.js" : [ "output/bimviews-%VERSION%.js" ]
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
							"output/bimviews.css" : [ "css/*.css" ]
						}
					}
				},
				copy : {
					main : {
						files : [
						// includes files within path and its sub-directories
						{
							expand : true,
							src : [ "fonts/**", "img/**" ],
							dest : "output/"
						}
					},
				},
				zip: {
					"output/bimviews-%VERSION%.zip": ["output/*"]
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
	grunt.loadNpmTasks("grunt-zip");

	grunt.registerTask("default", [ "concat", "uglify", "cssmin", "copy", "zip", "github-release" ]);
};
bimvie.ws
============

JavaScript client for Building Information Modelling, using open standards like IFC, BCF and BIMSie.
More info on http://bimvie.ws/

## How to get a working copy after a git clone:
if you do a plain checkout your missing the bimsurfer package (wich is implemented as a git submodule).
to utilize this do the following:

    $ cd <Path to bimvie.ws>
    $ git submodule update
    Cloning into 'js/bimsurfer'...
    remote: Reusing existing pack: 3329, done.
    remote: Total 3329 (delta 0), reused 0 (delta 0)
    Receiving objects: 100% (3329/3329), 34.91 MiB | 3.33 MiB/s, done.
    Resolving deltas: 100% (1685/1685), done.
    Checking connectivity... done
    Submodule path 'js/bimsurfer': checked out '636c9f03e7610ace088ca15602400b3f1c638e3b'
***

#ifndef _CREATE_GUID_64_H_
#define _CREATE_GUID_64_H_

#if defined (__cplusplus)
extern "C"{
#endif
//
// For all the following routines len contains the usable length of buf
// These routines will return NULL on failure and &buf on success.
// Upon successful completion buf will hold the resulting zero terminated strings.
//
char * CreateCompressedGuidString( char * buf, int len );                       // len >= 23
char * String64_To_HexaGuidString( const char *string64, char * buf, int len ); // len >= 39
char * String64_To_String85( const char *string64, char * buf, int len );       // len >= 21
char * String85_To_String64( const char *string85, char * buf, int len );       // len >= 23

#if defined (__cplusplus)
}
#endif

#endif

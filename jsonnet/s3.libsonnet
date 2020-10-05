local bucket(name) = {
	"bucket_prefix": name,
	"force_destroy": true,
	"acl": "private"
};
	
{
	"bucket": bucket
}
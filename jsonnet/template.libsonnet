local file(name, path, template, vars) = {
	data: {
		template_file: {
			[name]: {
				template: template,

				vars: vars
			}
		}
	},
	resource: {
		local_file: {
			[name]: {
				content: "${data.template_file." + name + ".rendered}",
				filename: "${path.module}/" + path,
				file_permission: "0664"
			}
		}
	}
};

{
	file: file
}